import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mutationReason } from './shell.mjs';
import { validateManifest, stripLineComments } from './store.mjs';
import { importFresh } from './runtime.mjs';

export const TODO_MARK = 'TODO(recipe)';

const REPL_ONLY = [
  [/\btools\.[A-Za-z_$][\w$]*\s*\(/g, 'tools.* call'],
  [/(?:^|[^.\w$])(?:Agent|Read|Skill|WebSearch|AskUserQuestion|Artifact|Workflow|ScheduleWakeup|SendFeedback|searchTools|describeTool|running)\s*\(/g, 'REPL tool call'],
];

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Finds $\x60...\x60 and mutate\x60...\x60 templates. A backtick nested inside an interpolation is not handled. */
export function shellTemplates(code) {
  const out = [];
  const re = /(^|[^\w$.])(\$|mutate)\x60((?:\\[\s\S]|[^\x60\\])*)\x60/g;
  let m;
  while ((m = re.exec(code))) {
    const start = m.index + m[1].length;
    const end = m.index + m[0].length;
    const chained = code.slice(end, end + 160).match(/^(?:\s*\.\s*\w+\([^()]*\))*/)[0];
    out.push({ tag: m[2], text: m[3], line: lineAt(code, start), readonly: /\.\s*readonly\s*\(/.test(chained) });
  }
  return out;
}

/** Hints for turning a captured script into a recipe: likely writes run through $, and calls that only exist in the REPL. */
export function analyzeCode(code) {
  const mutations = [];
  for (const t of shellTemplates(code)) {
    if (t.tag !== '$' || t.readonly) continue;
    const why = mutationReason(t.text.replace(/\$\{[^}]*\}/g, "''"));
    if (why) mutations.push({ line: t.line, command: t.text.trim().replace(/\s+/g, ' ').slice(0, 120), why });
  }
  const replOnly = [];
  for (const [re, what] of REPL_ONLY) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) replOnly.push({ line: lineAt(code, m.index), what: what + ' ' + m[0].replace(/^[^A-Za-z]+/, '').trim() });
  }
  return { mutations, replOnly };
}

/** Builds the three files of a new recipe around captured code. The TODO marker keeps \x60recipe check\x60 failing until the recipe is finished. */
export function scaffold({ name, description, code, source }) {
  const manifest = {
    name,
    description: description || TODO_MARK + ': say what this recipe does and when to use it',
    params: {},
    source,
  };
  const body = code.replace(/\s+$/, '').split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
  const recipe = [
    '// Recipe: ' + name,
    '// ' + TODO_MARK + ': finish the steps below, then delete this comment block; \x60recipe check\x60 fails while this marker is here.',
    '//   1. Replace hard-coded values (paths, names, ids, URLs) with params.<name> and declare each one in recipe.json.',
    '//   2. Wrap each command that changes something in mutate\x60...\x60 and any other side effect in step(\'what\', () => ...).',
    '//      write() and edit() already skip themselves in a dry run. A read-only $ command that looks like a write gets .readonly().',
    '//   3. Return the result: a REPL script returns its last expression, a recipe must use return.',
    '//   4. Define any variable the script took from an earlier REPL script.',
    '',
    'export default async function main(params, { $, mutate, step, edit, write, file, sleep, log, preview, dryRun }) {',
    body,
    '}',
    '',
  ].join('\n');
  const test = [
    "import assert from 'node:assert/strict';",
    '',
    '// Each case runs the recipe in a fresh temp directory, which is also its cwd.',
    '// dryRun defaults to true: mutate, step, write and edit are recorded in actions (skipped: true) instead of performed.',
    '// Optional fields: setup({ tmp, $, write, ... }) prepares files and may return extra params; dryRun: false; expectError: /regex/.',
    'export default [',
    '  {',
    "    name: 'dry run plans the expected actions',",
    '    params: {},',
    '    async check({ result, actions, logs, tmp }) {',
    '      // ' + TODO_MARK + ': assert on result and actions, then delete this line.',
    '      assert.ok(Array.isArray(actions));',
    '    },',
    '  },',
    '];',
    '',
  ].join('\n');
  return { manifest, recipe, test };
}

function usedParams(code) {
  const used = new Set();
  for (const m of code.matchAll(/\bparams\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)) used.add(m[1] || m[2]);
  const addPattern = (list) => {
    for (const part of list.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('...')) continue;
      used.add(t.split(/[:=]/)[0].trim());
    }
  };
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*params\b/g)) addPattern(m[1]);
  const sig = code.match(/export\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(\s*\{([^}]*)\}/);
  if (sig) addPattern(sig[1]);
  return used;
}

const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/, 'GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

/** Uses gitleaks when it is installed, otherwise a few built-in patterns. */
export function scanSecrets(dir) {
  const r = spawnSync('gitleaks', ['dir', dir, '--no-banner', '--redact', '--exit-code', '3', '--log-level', 'error'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return { errors: [], warnings: [] };
  if (!r.error && r.status === 3) return { errors: ['gitleaks found possible secrets; inspect with: gitleaks dir ' + dir + ' --redact -v'], warnings: [] };
  const warnings = r.error ? [] : ['gitleaks exited ' + r.status + '; used the built-in secret patterns instead'];
  const errors = [];
  for (const f of ['recipe.json', 'recipe.mjs', 'test.mjs']) {
    let text;
    try { text = fss.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) errors.push(f + ' contains what looks like a ' + what);
  }
  return { errors, warnings };
}

/** Static and load-time checks a recipe must pass before it is used. */
export async function checkRecipe(rec) {
  const errors = [];
  const warnings = [];
  if (rec.loadError) errors.push(rec.loadError);
  else errors.push(...validateManifest(rec.manifest, rec.name));

  let code = '';
  try { code = await fs.readFile(rec.entry, 'utf8'); } catch { errors.push('missing recipe.mjs'); }
  if (code) {
    if (code.includes(TODO_MARK)) errors.push('recipe.mjs still has the ' + TODO_MARK + ' marker');
    const live = stripLineComments(code);
    const { mutations, replOnly } = analyzeCode(live);
    for (const r of replOnly) errors.push('recipe.mjs line ' + r.line + ': ' + r.what + ' is only available inside the REPL');
    for (const m of mutations) warnings.push('recipe.mjs line ' + m.line + ': this $ command ' + m.why + '; wrap it in mutate or step, or chain .readonly() if it only reads');
    const declared = Object.keys((rec.manifest && rec.manifest.params) || {});
    const used = usedParams(live);
    for (const u of used) if (!declared.includes(u)) errors.push('recipe.mjs reads params.' + u + ' but recipe.json does not declare it');
    for (const d of declared) if (!used.has(d)) warnings.push('param "' + d + '" is declared but recipe.mjs never reads it');
    try {
      const mod = await importFresh(rec.entry);
      if (typeof mod.default !== 'function') errors.push('recipe.mjs must export default async function main(params, ctx)');
    } catch (e) { errors.push('recipe.mjs does not load: ' + e.message); }
  }

  if (!fss.existsSync(rec.testFile)) errors.push('missing test.mjs; add at least one case');
  else {
    const t = await fs.readFile(rec.testFile, 'utf8');
    if (t.includes(TODO_MARK)) errors.push('test.mjs still has the ' + TODO_MARK + ' marker');
    try {
      const cases = (await importFresh(rec.testFile)).default;
      if (!Array.isArray(cases) || cases.length === 0) errors.push('test.mjs must export default a non-empty array of cases');
    } catch (e) { errors.push('test.mjs does not load: ' + e.message); }
  }

  const secrets = scanSecrets(rec.dir);
  errors.push(...secrets.errors);
  warnings.push(...secrets.warnings);
  return { recipe: rec.name, ok: errors.length === 0, errors, warnings };
}
