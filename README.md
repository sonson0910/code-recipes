# code-recipes

A Claude Code plugin that turns a Code Mode (REPL) script that worked into an executable recipe: parameterized code with a dry run and a test, which Claude or you can run again without redoing the reasoning. Recipes are plain files, so a team reviews them like code.

## Install (local marketplace)

```bash
claude plugin marketplace add /path/to/code-recipes
claude plugin install code-recipes@code-recipes
```

Run `/reload-plugins` in a session that is already open. Requires Node 20 or later.

## What it adds

- **Capture hook** (PostToolUse on `REPL`): when a script ends, appends its code and whether it worked (plus its `tool_use_id`, from which `recipe captures` finds the eval number `#N` in the session transcript) to `~/.claude/recipes/.captures/<session>.jsonl` (mode 0600, pruned after 14 days). It prints nothing and never blocks a call.
- **SessionStart hook**: prints a short index of installed recipes as context; with no recipes it prints nothing.
- **`recipe` CLI** in `bin/`: on the Bash tool's PATH while the plugin is enabled.
- **`code-recipes:recipe` skill**: tells Claude when to run a recipe and how to save one.

## Use

```bash
recipe captures                          # scripts captured in this session (--all for every session)
recipe new deploy-preview --from '#12'   # scaffold from a capture (id or #eval); --project saves into the repo
# edit ~/.claude/recipes/deploy-preview/{recipe.json,recipe.mjs,test.mjs}
recipe check deploy-preview              # manifest, TODO markers, undeclared params, REPL-only calls, secrets
recipe test deploy-preview               # cases in test.mjs, each in a fresh temp dir, dry run by default
recipe run deploy-preview --dry-run -p branch=feat/x
recipe run deploy-preview --json --params '{"branch":"feat/x"}'
```

In Code Mode: `await $\\`recipe run NAME --json --params ${JSON.stringify(params)}\\`.nothrow().json()`.

A recipe gets the REPL globals (`$`, `edit`, `write`, `file`, `sleep`, `log`, `preview`) plus `mutate` and `step`, which a dry run records instead of performing. In a dry run `$` refuses commands that look like writes. See [the skill](plugins/code-recipes/skills/recipe/SKILL.md) for the full format.

User recipes live in `~/.claude/recipes/` (`RECIPES_HOME`), project recipes in `<repo>/.claude/recipes/`; a project recipe hides a user recipe of the same name.

## Limits

- A recipe is a Node process: `tools.*`, `Agent`, `Read` and MCP calls are not available. Pass their output in as params.
- The dry-run guard is a heuristic. Wrap every side effect in `mutate` or `step` rather than relying on it.
- A project recipe is code from the repository; read it (`recipe show`) before its first run.

## Develop

```bash
npm test
claude plugin validate .
```

## Uninstall

```bash
claude plugin uninstall code-recipes@code-recipes
claude plugin marketplace remove code-recipes
rm -rf ~/.claude/recipes/.captures   # captured scripts; your recipes stay in ~/.claude/recipes
```
