import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  listRecipes, findRecipe, readCaptures, resolveCapture, fillEvalIds, userRecipesDir, projectRecipesDir,
  capturesDir, gitRoot, NAME_RE, indexText, indexLines, hasSideEffects, dismissCapture,
} from './store.mjs';
import { runRecipe, runTests } from './runtime.mjs';
import { scaffold, analyzeCode, checkRecipe } from './authoring.mjs';
import { killActiveChildren } from './shell.mjs';

const HELP = `recipe: run and manage executable recipes saved from Code Mode scripts

Usage:
  recipe list [--json]                       installed recipes (project ones first)
  recipe show <name>                         manifest and code
  recipe run <name> [options]                run a recipe
      -p, --param key=value   one param (repeatable; strings are coerced to the declared type)
      --params JSON           params as a JSON object
      --params-file PATH      params from a JSON file
      -n, --dry-run           record mutate/step/write/edit in actions instead of doing them
      --cwd DIR               working directory for the recipe (default: current)
      --timeout MS            default timeout per shell command
      --json                  print one JSON report (ok, result, actions, logs, error)
  recipe test [name...] [--json]             run the cases in each recipe's test.mjs
  recipe check [name...] [--json]            validate manifest, code, tests and secrets
  recipe captures [--all | --session ID] [--status ok|error|dispatched] [--limit N] [--json]
                                             REPL scripts captured by the plugin hook
  recipe capture <id|#eval>                  print one captured script
  recipe new <name> (--from <id|#eval>[,...] | --file PATH) [--project] [-d TEXT] [--force]
                                             scaffold a recipe from captured scripts
  recipe dismiss <id|#eval>[,...]            stop suggesting scripts like these as recipes
  recipe index                               the recipe index the SessionStart hook prints
  recipe where                               directories in use

Environment: RECIPES_HOME (user recipes, default ~/.claude/recipes), RECIPES_CAPTURE_DIR,
RECIPES_CAPTURE_TTL_DAYS (default 14), RECIPES_FINGERPRINT_TTL_DAYS (default 60),
RECIPES_AUTOSAVE (auto by default; ask, or 0 to turn off), RECIPES_SIMILARITY (default 0.45),
RECIPES_SHELL (default /bin/bash), RECIPES_DEBUG.
`;

const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const err = (s) => process.stderr.write(s.endsWith('\n') ? s : s + '\n');

class UsageError extends Error {}
const usage = (msg) => new UsageError(msg);

function parse(args, options, allowPositionals = true) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (e) {
    throw usage(e.message);
  }
}

async function mustFind(name) {
  const rec = await findRecipe(name, process.cwd());
  if (rec) return rec;
  const names = (await listRecipes(process.cwd())).map((r) => r.name);
  throw new Error('no recipe named "' + name + '"' + (names.length ? '. Known: ' + names.join(', ') : '. There are no recipes yet.'));
}

function parseJsonObject(text, what) {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw usage(what + ' is not valid JSON: ' + e.message); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw usage(what + ' must be a JSON object');
  return v;
}

async function cmdList(args) {
  const { values } = parse(args, { json: { type: 'boolean' } }, false);
  const recipes = await listRecipes(process.cwd());
  if (values.json) {
    out(JSON.stringify(recipes.map((r) => ({
      name: r.name, scope: r.scope, dir: r.dir, description: r.manifest.description,
      params: r.manifest.params || {}, changesThings: hasSideEffects(r), error: r.loadError,
    })), null, 2));
    return 0;
  }
  if (!recipes.length) {
    out('No recipes yet. User recipes live in ' + userRecipesDir() + ', project recipes in <repo>/.claude/recipes.\nCreate one from a captured script: recipe captures, then recipe new <name> --from <id|#eval>.');
    return 0;
  }
  out(indexLines(recipes).join('\n'));
  return 0;
}

async function cmdShow(args) {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw usage('usage: recipe show <name>');
  const rec = await mustFind(positionals[0]);
  out('# ' + rec.name + ' (' + rec.scope + ') ' + rec.dir);
  out(JSON.stringify(rec.manifest, null, 2));
  out('\n# recipe.mjs');
  out(await fs.readFile(rec.entry, 'utf8').catch(() => '(missing)'));
  return 0;
}

function printRun(res) {
  const mode = res.dryRun ? 'dry run, ' : '';
  if (res.ok) out('✓ ' + res.recipe + ' (' + mode + res.ms + ' ms)');
  else err('✗ ' + res.recipe + ' failed (' + mode + res.ms + ' ms): ' + res.error.message);
  if (res.actions.length) {
    out('Actions:');
    for (const a of res.actions) {
      const state = a.skipped ? 'skipped' : 'done   ';
      const what = a.kind === 'shell' ? a.command : a.kind === 'step' ? a.label : a.path + (a.bytes !== undefined ? ' (' + a.bytes + ' bytes)' : ' (' + a.replacements + ' replacements)');
      out('  ' + state + ' ' + a.kind.padEnd(5) + ' ' + String(what).replace(/\n/g, '\\n').slice(0, 200));
    }
  }
  if (res.ok && res.result !== null) out('Result:\n' + (typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)));
}

async function cmdRun(args) {
  const { values, positionals } = parse(args, {
    param: { type: 'string', multiple: true, short: 'p' },
    params: { type: 'string' },
    'params-file': { type: 'string' },
    'dry-run': { type: 'boolean', short: 'n' },
    cwd: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (positionals.length !== 1) throw usage('usage: recipe run <name> [--param key=value]... [--params JSON] [--dry-run] [--json]');
  const rec = await mustFind(positionals[0]);
  let input = {};
  if (values['params-file']) input = { ...input, ...parseJsonObject(await fs.readFile(values['params-file'], 'utf8'), '--params-file') };
  if (values.params) input = { ...input, ...parseJsonObject(values.params, '--params') };
  for (const kv of values.param || []) {
    const i = kv.indexOf('=');
    if (i < 1) throw usage('--param expects key=value, got "' + kv + '"');
    input[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const json = Boolean(values.json);
  const timeout = values.timeout ? Number(values.timeout) : undefined;
  if (values.timeout && !(timeout > 0)) throw usage('--timeout must be a positive number of milliseconds');
  const res = await runRecipe(rec, input, {
    dryRun: Boolean(values['dry-run']),
    cwd: values.cwd ? path.resolve(values.cwd) : process.cwd(),
    captureConsole: json,
    onLog: json ? undefined : (l) => err('· ' + l),
    timeout,
  });
  if (json) out(JSON.stringify(res, null, 2));
  else printRun(res);
  return res.ok ? 0 : 1;
}

async function selectRecipes(names) {
  if (names.length) return Promise.all(names.map(mustFind));
  return listRecipes(process.cwd());
}

async function cmdTest(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const recipes = await selectRecipes(positionals);
  const results = [];
  for (const rec of recipes) {
    if (!values.json) out(rec.name + ':');
    results.push(await runTests(rec, {
      onCase: values.json ? undefined : (c) => out('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : ': ' + c.error)),
    }));
    const last = results[results.length - 1];
    if (!values.json && last.cases.length === 1 && last.cases[0].name === '(load test.mjs)') out('  ✗ ' + last.cases[0].error);
  }
  const failed = results.reduce((n, r) => n + r.failed, 0);
  const passed = results.reduce((n, r) => n + r.passed, 0);
  if (values.json) out(JSON.stringify({ ok: failed === 0, passed, failed, recipes: results }, null, 2));
  else out(recipes.length ? passed + ' passed, ' + failed + ' failed' : 'No recipes to test.');
  return failed ? 1 : 0;
}

async function cmdCheck(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const recipes = await selectRecipes(positionals);
  const results = [];
  for (const rec of recipes) results.push(await checkRecipe(rec));
  const ok = results.every((r) => r.ok);
  if (values.json) out(JSON.stringify({ ok, recipes: results }, null, 2));
  else {
    if (!recipes.length) out('No recipes to check.');
    for (const r of results) {
      out((r.ok ? '✓ ' : '✗ ') + r.recipe);
      for (const e of r.errors) out('  error: ' + e);
      for (const w of r.warnings) out('  warning: ' + w);
    }
  }
  return ok ? 0 : 1;
}

function age(ts) {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 129600) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

function summary(c) {
  const first = c.code.split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) || '';
  return (c.description || first.trim()).replace(/\s+/g, ' ').slice(0, 90);
}

async function cmdCaptures(args) {
  const { values } = parse(args, {
    all: { type: 'boolean' }, session: { type: 'string' }, status: { type: 'string' },
    limit: { type: 'string' }, json: { type: 'boolean' },
  }, false);
  const session = values.session || process.env.CLAUDE_CODE_SESSION_ID;
  let caps = await readCaptures({ session: values.all ? undefined : session, all: Boolean(values.all) });
  if (values.status) caps = caps.filter((c) => c.status === values.status);
  const limit = values.limit ? Number(values.limit) : 30;
  caps = await fillEvalIds(caps.slice(-limit));
  if (values.json) { out(JSON.stringify(caps, null, 2)); return 0; }
  if (!caps.length) {
    out('No captured scripts' + (session && !values.all ? ' for session ' + session : '') + '. Captures dir: ' + capturesDir() +
      '\nScripts are captured by the plugin\'s PostToolUse hook on REPL; if this stays empty in a Code Mode session, check /hooks.');
    return 0;
  }
  out('id        eval  status      lines  age   description');
  for (const c of caps) {
    out([
      c.id.padEnd(9), (c.evalId != null ? '#' + c.evalId : '-').padEnd(5), String(c.status).padEnd(11),
      String(c.lines).padStart(5), ' ' + age(c.ts).padEnd(5), summary(c),
    ].join(' '));
  }
  return 0;
}

async function findCaptures(refs) {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const current = await fillEvalIds(await readCaptures({ session }));
  let everything = null;
  const found = [];
  for (const ref of refs) {
    let c = resolveCapture(ref, current);
    if (!c && !String(ref).startsWith('#')) {
      everything = everything || await readCaptures({ all: true });
      c = resolveCapture(ref, everything);
    }
    if (!c) throw new Error('no capture matches "' + ref + '"' + (String(ref).startsWith('#') ? ' in the current session' : '') + '; list them with: recipe captures');
    found.push(c);
  }
  return found;
}

async function cmdCapture(args) {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw usage('usage: recipe capture <id|#eval>');
  const [c] = await findCaptures([positionals[0]]);
  out('// capture ' + c.id + (c.evalId != null ? ' (#' + c.evalId + ')' : '') + ', status ' + c.status + ', ' + c.ts + (c.description ? ', ' + c.description : ''));
  if (c.error) out('// error: ' + c.error.split('\n')[0]);
  out(c.code);
  return 0;
}

async function cmdDismiss(args) {
  const { positionals } = parse(args, {});
  const refs = positionals.flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!refs.length) throw usage('usage: recipe dismiss <id|#eval>[,...]');
  const caps = await findCaptures(refs);
  for (const c of caps) await dismissCapture(c);
  out('Dismissed ' + caps.map((c) => c.id).join(', ') + ': scripts like ' + (caps.length > 1 ? 'these' : 'this one') + ' will not be suggested as recipes again.');
  return 0;
}

async function cmdNew(args) {
  const { values, positionals } = parse(args, {
    from: { type: 'string' }, file: { type: 'string' }, project: { type: 'boolean' },
    description: { type: 'string', short: 'd' }, force: { type: 'boolean' },
  });
  if (positionals.length !== 1 || (!values.from && !values.file) || (values.from && values.file)) {
    throw usage('usage: recipe new <name> (--from <id|#eval>[,...] | --file PATH) [--project] [--description TEXT] [--force]');
  }
  const name = positionals[0];
  if (!NAME_RE.test(name)) throw usage('recipe name must be kebab-case: lowercase letters, digits and dashes, at most 64 characters');

  let code;
  let source;
  const notes = [];
  if (values.from) {
    const caps = await findCaptures(values.from.split(',').map((s) => s.trim()).filter(Boolean));
    for (const c of caps) if (c.status !== 'ok') notes.push('capture ' + c.id + ' has status ' + c.status + '; make sure the script really worked');
    code = caps.length === 1 ? caps[0].code : caps.map((c) => '// --- capture ' + c.id + (c.description ? ': ' + c.description : '') + '\n' + c.code).join('\n\n');
    source = { captures: caps.map((c) => ({ id: c.id, evalId: c.evalId ?? null, session: c.session, capturedAt: c.ts, description: c.description || undefined })) };
  } else {
    code = await fs.readFile(values.file, 'utf8');
    source = { file: path.resolve(values.file) };
  }

  const root = values.project
    ? projectRecipesDir(process.cwd()) || path.join(gitRoot(process.cwd()) || process.cwd(), '.claude', 'recipes')
    : userRecipesDir();
  const dir = path.join(root, name);
  if (fss.existsSync(dir) && !values.force) throw new Error(dir + ' already exists; pass --force to replace it');
  const other = await findRecipe(name, process.cwd());
  if (other && other.dir !== dir) notes.push('a ' + other.scope + ' recipe with this name exists at ' + other.dir + (values.project ? '; the project one will hide it' : ''));

  const files = scaffold({ name, description: values.description, code, source });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify(files.manifest, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'recipe.mjs'), files.recipe);
  await fs.writeFile(path.join(dir, 'test.mjs'), files.test);

  const { mutations, replOnly } = analyzeCode(files.recipe.replace(/^\s*\/\/.*$/gm, ''));
  out('Created ' + (values.project ? 'project' : 'user') + ' recipe "' + name + '" in ' + dir);
  for (const n of notes) out('note: ' + n);
  if (mutations.length || replOnly.length) out('Hints for recipe.mjs:');
  for (const m of mutations) out('  line ' + m.line + ': $ command ' + m.why + ' -> mutate or step: ' + m.command);
  for (const r of replOnly) out('  line ' + r.line + ': ' + r.what + ' only works inside the REPL; pass its output in as a param');
  out('Next: finish recipe.mjs and recipe.json, write a real case in test.mjs, then run\n  recipe check ' + name + ' && recipe test ' + name + ' && recipe run ' + name + ' --dry-run');
  return 0;
}

async function cmdIndex(args) {
  parse(args, {}, false);
  const text = indexText(await listRecipes(process.cwd()));
  if (text) out(text);
  return 0;
}

async function cmdWhere(args) {
  parse(args, {}, false);
  out('user recipes:    ' + userRecipesDir());
  out('project recipes: ' + (projectRecipesDir(process.cwd()) || '(none above ' + process.cwd() + ')'));
  out('captures:        ' + capturesDir());
  out('session:         ' + (process.env.CLAUDE_CODE_SESSION_ID || '(not in a Claude Code session)'));
  return 0;
}

const COMMANDS = {
  list: cmdList, show: cmdShow, run: cmdRun, test: cmdTest, check: cmdCheck,
  captures: cmdCaptures, capture: cmdCapture, new: cmdNew, dismiss: cmdDismiss, index: cmdIndex, where: cmdWhere,
};

export async function main(argv) {
  const stop = (code) => () => { killActiveChildren(); process.exit(code); };
  process.on('SIGINT', stop(130));
  process.on('SIGTERM', stop(143));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { out(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { err('unknown command: ' + cmd + '\n\n' + HELP); return 2; }
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return 2; }
    err(process.env.RECIPES_DEBUG ? e.stack : 'recipe: ' + e.message);
    return 1;
  }
}
