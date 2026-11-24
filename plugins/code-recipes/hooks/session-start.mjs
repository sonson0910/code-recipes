// SessionStart hook: prunes old captures and prints the recipe index as context. With no recipes it prints nothing.
// The recipe CLI needs no PATH setup: Claude Code puts a plugin's bin/ on the Bash tool's PATH while the plugin is enabled.
import { listRecipes, pruneCaptures, indexText } from '../lib/store.mjs';

let ev = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  ev = JSON.parse(raw || '{}');
} catch { /* no input */ }

try { await pruneCaptures(); } catch { /* best effort */ }

try {
  const text = indexText(await listRecipes(ev.cwd || process.cwd()));
  if (text) process.stdout.write(text + '\n');
} catch { /* best effort */ }

process.exit(0);
