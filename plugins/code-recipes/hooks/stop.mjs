// Stop hook: when scripts in this session repeated earlier runs, asks Claude, before the turn ends, to save each as a
// recipe or dismiss it (or, with RECIPES_AUTOSAVE=ask, to ask the user). At most two per Stop, each reported once.
// Prints nothing otherwise. RECIPES_AUTOSAVE=0 turns it off.
import { pathToFileURL } from 'node:url';
import { takeUnreportedRepeats, fillEvalIds, autosaveMode } from '../lib/store.mjs';

function ago(ts, now) {
  const h = (now - Date.parse(ts)) / 3600000;
  if (!Number.isFinite(h)) return 'earlier';
  return h < 1 ? 'under an hour ago' : h < 48 ? Math.round(h) + ' hours ago' : Math.round(h / 24) + ' days ago';
}

export function stopMessage(prints, now = Date.now(), mode = 'auto') {
  const lines = prints.map((p) => {
    const ref = (p.evalId != null ? '#' + p.evalId + ' ' : '') + p.id + (p.description ? ' "' + p.description + '"' : '');
    const earlier = p.repeats.map((r) => r.id + (r.description ? ' "' + r.description + '"' : '') + ', ' + ago(r.ts, now) + ', ' + Math.round(r.score * 100) + '% alike');
    const from = [...new Set([p.id, ...p.repeats.filter((r) => r.captured !== false).map((r) => r.id)])].join(',');
    return '- ' + ref + ' repeats ' + earlier.join('; ') + '. Scaffold: `recipe new <name> --from ' + from + '`';
  });
  const what = mode === 'ask'
    ? [
        'Before you finish, ask the user in one short question whether to save each one as a recipe (suggest a kebab-case name), then stop.',
        'If they agree, start from its scaffold command and finish the recipe as the code-recipes:recipe skill describes; if they decline, run `recipe dismiss <id>`.',
      ]
    : [
        'Before you finish, handle each one yourself, without asking the user (the code-recipes:recipe skill has the format):',
        '- Worth keeping (a task likely to come back, not exploration, debugging or a one-off edit): run its scaffold command with a kebab-case name, make the values that differ between the runs params, finish recipe.mjs and test.mjs, then run `recipe check <name>` and `recipe test <name>` until both pass.',
        '- Not worth keeping: `recipe dismiss <id>`, so scripts like it are not suggested again.',
        'Then tell the user in one line what you saved or dismissed.',
      ];
  return ['code-recipes: scripts you ran in this session repeat earlier runs, so they are recipe candidates:', ...lines, '', ...what].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const ev = JSON.parse(raw || '{}');
    const mode = autosaveMode();
    if (mode !== 'off' && !ev.stop_hook_active && ev.session_id) {
      const prints = await takeUnreportedRepeats(ev.session_id);
      if (prints.length) {
        if (typeof ev.transcript_path === 'string') for (const p of prints) p.transcript = ev.transcript_path;
        await fillEvalIds(prints);
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: stopMessage(prints, Date.now(), mode) } }) + '\n');
      }
    }
  } catch {
    // Saving recipes is optional; a failure here must never keep the session from stopping.
  }
  process.exit(0);
}
