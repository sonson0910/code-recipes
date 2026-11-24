---
name: recipe
description: Run saved executable recipes instead of redoing a task by hand, and save a Code Mode (REPL) script that worked as a recipe with params, a dry run and a test. Use when a task matches an installed recipe, when the user asks to save, reuse or replay what was just done ("save this as a recipe", "lưu thành recipe", "chạy lại cái này"), when you are about to rewrite a multi-step script you already ran before, or when the code-recipes Stop hook reports scripts that repeat work from earlier sessions.
---

# Executable recipes

A recipe is a script that already worked, saved as code: `recipe.json` (description and params), `recipe.mjs` (the code) and `test.mjs` (cases). Running one costs no reasoning and gives the same result each time. The `recipe` CLI runs them in Node, outside the REPL, so the REPL's ban on eval does not matter.

Where recipes live: user recipes in `~/.claude/recipes/<name>/`, project recipes in `<repo>/.claude/recipes/<name>/` (a project recipe hides a user recipe of the same name). `recipe where` prints the paths in use.

## Run a recipe

```js
// In Code Mode. --json prints one report; .nothrow() keeps a failed run readable.
const r = await $`recipe run release-notes --json --dry-run --params ${JSON.stringify({ tag: 'v1.4.0' })}`.nothrow().json();
// r = { ok, result, actions: [{kind, command|path|label, skipped}], logs, error: {name, message} | undefined }
```

From Bash: `recipe run release-notes --dry-run -p tag=v1.4.0` (`-p` repeats; values are coerced to the declared types).

- Run a recipe marked "changes things" with `--dry-run` first. Read `actions`: every `mutate`, `step`, `write` and `edit` is listed with `skipped: true`. Then run it for real.
- A project recipe came with the repository. Read it with `recipe show <name>` before its first run, as you would any script you did not write.
- `recipe list` and `recipe show <name>` describe what is installed. The SessionStart hook already put the index in context when recipes exist.
- If a recipe fails, read `error.message`; fix the recipe (then `recipe test`), do not silently work around it by hand.

## Save a script as a recipe

The plugin's PostToolUse hook records every REPL script when it ends, with whether it worked. `recipe captures` shows its eval number (`#N`) when the session transcript has the receipt; otherwise use the id.

1. Find the script: `recipe captures` (this session; `--all` for every session). Each row shows id, `#eval`, status and description. `recipe capture <id|#eval>` prints one.
2. Scaffold: `recipe new <name> --from '#12'` (several: `--from '#12,#14'`; a file: `--file path.js`; add `--project` to save into the repository, `-d "description"` for the description). Pick only captures with status `ok`. The command prints hints: `$` commands that look like writes, and REPL-only calls.
3. Edit `recipe.mjs`:
   - Replace hard-coded values with `params.<name>` and declare each in `recipe.json`.
   - Wrap commands that change something in `mutate` and other side effects in `step('label', () => ...)`. `write` and `edit` already skip themselves in a dry run.
   - `return` the result (a REPL script returns its last expression; a recipe must use `return`).
   - Define every variable the script took from an earlier REPL script.
   - Delete the `TODO(recipe)` comment block.
4. Write real cases in `test.mjs` and delete its `TODO(recipe)` line.
5. `recipe check <name> && recipe test <name> && recipe run <name> --dry-run ...`, then a real run. `check` fails while a `TODO(recipe)` marker, an undeclared param, a REPL-only call or a possible secret remains.

## recipe.json

```json
{
  "name": "release-notes",
  "description": "Draft release notes for a tag from merged PRs since the previous tag. Use before tagging a release.",
  "params": {
    "tag": { "type": "string", "required": true, "description": "the new tag, e.g. v1.4.0" },
    "limit": { "type": "number", "default": 50 },
    "format": { "type": "string", "enum": ["md", "json"], "default": "md" }
  }
}
```

Types: `string`, `number`, `boolean`, `array` (JSON or comma-separated on the CLI), `object` (JSON). Unknown params and missing required ones are errors. The description is what Claude sees in the index: say what it does and when to use it.

## recipe.mjs

```js
export default async function main(params, { $, mutate, step, edit, write, file, sleep, log, preview, dryRun, cwd }) {
  const prs = await $`gh pr list --state merged --limit ${params.limit} --json number,title`.json();
  const notes = prs.map((p) => '- ' + p.title + ' (#' + p.number + ')').join('\\n');
  await write('RELEASE_NOTES.md', notes + '\\n');           // recorded and skipped in a dry run
  await mutate`git tag ${params.tag}`;                    // recorded and skipped in a dry run
  log('drafted', prs.length, 'entries');
  return { count: prs.length };
}
```

The context matches the REPL globals, with these differences:

| | REPL | recipe |
|---|---|---|
| `$` | runs anything | in a dry run, refuses a command that looks like a write (rm, mv, git push, `>` into a file, curl -X POST, kubectl apply, ...). Chain `.readonly()` on a command that only reads but looks like a write. |
| `mutate` | — | same as `$`, but in a dry run it is recorded and returns empty output (`''`, `[]`, `null` from `.json()`). |
| `step(label, fn)` | — | runs `fn` normally; in a dry run records `label` and returns `undefined`. |
| `write`, `edit` | write | in a dry run they record the change; `edit` still checks its anchors. Relative paths resolve against the run's cwd (`--cwd`). |
| `tools.*`, `Agent`, `Read`, MCP | available | not available: a recipe is a plain Node process. Pass what such a call produced in as a param, or keep that part in the REPL. |
| result | last expression | `return` value |

`$` behaves like the REPL's: interpolated values are single-quoted (arrays one argument per item, `{raw: s}` unquoted), stderr is merged into stdout, a non-zero exit throws except exit 1 from grep/rg/find/diff/test/git diff, `.nothrow() .timeout(ms) .cwd(dir) .env({}) .text() .lines() .json()` chain, `$(cmd, ms)` takes a plain string. Commands run with `/bin/bash` and a 10 minute default timeout (`--timeout` changes it).

## test.mjs

```js
import assert from 'node:assert/strict';
export default [
  { name: 'dry run plans the tag', params: { tag: 'v9.9.9' },
    setup: async ({ $, write, tmp }) => { await $`git init -q`; },   // may return extra params
    check: ({ result, actions }) => assert.ok(actions.some((a) => a.kind === 'shell' && a.command.includes('git tag'))) },
  { name: 'tag is required', params: {}, expectError: /missing required param "tag"/ },
];
```

Each case runs in a fresh temp directory, which is the recipe's cwd. `dryRun` defaults to `true`; set `dryRun: false` to perform the actions inside that directory.

## When the Stop hook reports a repeat

The capture hook fingerprints each REPL script that worked and has at least 20 distinct words (a MinHash of its words; the fingerprint holds no code). When a script that worked is at least 45% alike (`RECIPES_SIMILARITY`) to one that worked in another session, or in this session at least 2 hours earlier, within the last 60 days, the Stop hook lists both before your turn ends: at most two per turn, each once. Unless the report says to ask the user (`RECIPES_AUTOSAVE=ask`), the user turned this on so that saving happens without them asking, so handle each listed script yourself:

- **Worth keeping** (a task likely to come back: deploy, release, backup, environment setup, a recurring report): run the scaffold command the report gives (`recipe new <name> --from <ids>`). The scaffold holds every run whose capture is still kept; the values that differ between them are the params. Finish it as in the steps above, in the user store unless the user asked for a project recipe, and stop only when `recipe check` and `recipe test` pass.
- **Not worth keeping** (exploration, a debugging probe, a one-off edit, a fix that will not recur): `recipe dismiss <this id>`, so scripts like it are not reported again.
- Then tell the user in one line what you saved or dismissed.

A script that an existing recipe already covers (its code is alike to the recipe's, or an earlier run it repeats is the recipe's source) is not reported; the capture hook adds a one-line note naming the recipe instead. Run that recipe the next time the task comes up. `RECIPES_AUTOSAVE=0` turns all of this off.

## Rules

- No secrets in a recipe. Read tokens from the environment at run time (`process.env.GITHUB_TOKEN`) or from the CLI that already holds them (`gh`). `recipe check` runs gitleaks.
- Captures hold the raw code of every REPL script for 14 days (`RECIPES_CAPTURE_TTL_DAYS`) in `~/.claude/recipes/.captures/`, mode 0600. Do not copy them anywhere else.
- Keep a recipe to one job. Two related jobs are two recipes.
- Change a recipe through its files, then `recipe test <name>`. Project recipes are reviewed like code.
