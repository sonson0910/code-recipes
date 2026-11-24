// PostToolUse hook for the REPL tool: appends the script and whether it worked to the session's capture file.
// It prints nothing and always exits 0, so it never changes what Claude sees or blocks a call.
// Claude Code runs it once, when the script ends. The payload has the code, result and error but not the eval number,
// and the receipt "(dispatched #N)" may not be in the transcript yet, so the record keeps the transcript path and
// tool_use_id and the recipe CLI looks the number up when it reads captures.
import { pathToFileURL } from 'node:url';
import { appendCapture, captureId } from '../lib/store.mjs';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const ev = JSON.parse(raw);
    const rec = captureRecord(ev);
    if (rec) await appendCapture(rec);
  } catch {
    // A capture failure must never disturb the session.
  }
  process.exit(0);
}
