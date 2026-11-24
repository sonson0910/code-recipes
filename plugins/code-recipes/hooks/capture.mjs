// PostToolUse hook for the REPL tool: appends the script and whether it worked to the session's capture file.
// It always exits 0 and never blocks a call. For a script that worked it also appends a fingerprint and notes the earlier
// runs it repeats (reported by hooks/stop.mjs). Its only output is a one-line note when a recipe already does what the
// script did, so Claude runs the recipe next time.
// Claude Code runs it once, when the script ends. The payload has the code, result and error but not the eval number,
// and the receipt "(dispatched #N)" may not be in the transcript yet, so the record keeps the transcript path and
// tool_use_id and the recipe CLI looks the number up when it reads captures.
import { pathToFileURL } from 'node:url';
import { appendCapture, captureId, recordFingerprint } from '../lib/store.mjs';

const MAX_CODE = 256 * 1024;
const RECEIPT = /^\s*\(dispatched #(\d+)\)\s*$/;

export function captureRecord(ev, now = new Date()) {
  if (!ev || ev.tool_name !== 'REPL') return null;
  const input = ev.tool_input || {};
  const resp = ev.tool_response;
  const respObj = resp && typeof resp === 'object' ? resp : null;
  const code = typeof input.code === 'string' ? input.code : respObj && typeof respObj.code === 'string' ? respObj.code : '';
  if (!code.trim()) return null;
  const resultText = typeof resp === 'string' ? resp : respObj && typeof respObj.result === 'string' ? respObj.result : '';
  const receipt = resultText.match(RECEIPT);
  const error = respObj && respObj.error != null && respObj.error !== '' ? String(respObj.error) : '';
  const status = error ? 'error' : receipt ? 'dispatched' : resp == null ? 'unknown' : 'ok';
  const session = ev.session_id || 'unknown';
  return {
    v: 1,
    id: captureId(session, code),
    ts: now.toISOString(),
    session,
    cwd: ev.cwd || null,
    toolUseId: ev.tool_use_id || null,
    transcript: typeof ev.transcript_path === 'string' ? ev.transcript_path : null,
    evalId: receipt ? Number(receipt[1]) : null,
    description: typeof input.description === 'string' ? input.description.slice(0, 200) : '',
    status,
    error: error ? error.slice(0, 500) : undefined,
    responseKeys: respObj ? Object.keys(respObj).slice(0, 20) : typeof resp,
    lines: code.split('\n').length,
    truncated: code.length > MAX_CODE || undefined,
    code: code.length > MAX_CODE ? code.slice(0, MAX_CODE) : code,
  };
}

export function reuseNote({ name, score }) {
  return 'code-recipes: this script did what recipe "' + name + '" does (' + Math.round(score * 100) + '% alike). Next time run `recipe run ' + name + '` (params: `recipe show ' + name + '`) instead of writing the script again.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const ev = JSON.parse(raw);
    const rec = captureRecord(ev);
    if (rec) {
      await appendCapture(rec);
      const fp = await recordFingerprint(rec, { cwd: ev.cwd });
      if (fp && fp.recipe) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reuseNote(fp.recipe) } }) + '\n');
    }
  } catch {
    // A capture failure must never disturb the session.
  }
  process.exit(0);
}
