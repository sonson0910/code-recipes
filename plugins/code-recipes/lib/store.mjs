import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PARAM_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
const SIDE_EFFECT_RE = /\bmutate\s*(?:\x60|\()|\bstep\s*\(|\bwrite\s*\(|\bedit\s*\(/;

export function userRecipesDir() {
  return process.env.RECIPES_HOME ? path.resolve(process.env.RECIPES_HOME) : path.join(os.homedir(), '.claude', 'recipes');
}

export function capturesDir() {
  return process.env.RECIPES_CAPTURE_DIR ? path.resolve(process.env.RECIPES_CAPTURE_DIR) : path.join(userRecipesDir(), '.captures');
}

function isDir(p) {
  try { return fss.statSync(p).isDirectory(); } catch { return false; }
}

/** Nearest <dir>/.claude/recipes above cwd, skipping the home directory (that one is the user store). */
export function projectRecipesDir(cwd = process.cwd()) {
  const home = os.homedir();
  const user = userRecipesDir();
  let dir = path.resolve(cwd);
  for (;;) {
    if (dir !== home) {
      const cand = path.join(dir, '.claude', 'recipes');
      if (cand !== user && isDir(cand)) return cand;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function gitRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fss.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadRecipe(dir, scope) {
  const name = path.basename(dir);
  const rec = {
    name, scope, dir,
    manifestFile: path.join(dir, 'recipe.json'),
    entry: path.join(dir, 'recipe.mjs'),
    testFile: path.join(dir, 'test.mjs'),
  };
  try {
    rec.manifest = JSON.parse(await fs.readFile(rec.manifestFile, 'utf8'));
  } catch (e) {
    rec.manifest = { name, description: '', params: {} };
    rec.loadError = 'recipe.json: ' + e.message;
  }
  return rec;
}

/** Project recipes first, then user recipes; a project recipe hides a user recipe of the same name. */
export async function listRecipes(cwd = process.cwd()) {
  const seen = new Map();
  for (const [root, scope] of [[projectRecipesDir(cwd), 'project'], [userRecipesDir(), 'user']]) {
    if (!root) continue;
    let names;
    try { names = await fs.readdir(root); } catch { continue; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || seen.has(n)) continue;
      const dir = path.join(root, n);
      if (!isDir(dir) || !fss.existsSync(path.join(dir, 'recipe.json'))) continue;
      seen.set(n, await loadRecipe(dir, scope));
    }
  }
  return [...seen.values()];
}

export async function findRecipe(name, cwd = process.cwd()) {
  return (await listRecipes(cwd)).find((r) => r.name === name) || null;
}

/** Blanks whole-line // comments, keeping line numbers, so instructions in comments do not count as code. */
export function stripLineComments(code) {
  return code.replace(/^\s*\/\/.*$/gm, '');
}

export function hasSideEffects(rec) {
  try { return SIDE_EFFECT_RE.test(stripLineComments(fss.readFileSync(rec.entry, 'utf8'))); } catch { return false; }
}

export function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['recipe.json must be a JSON object'];
  const errors = [];
  if (m.name !== dirName) errors.push('recipe.json name "' + m.name + '" must match its directory "' + dirName + '"');
  if (!NAME_RE.test(String(m.name))) errors.push('name must be kebab-case: lowercase letters, digits and dashes, at most 64 characters');
  if (typeof m.description !== 'string' || m.description.trim().length < 10) errors.push('description must say what the recipe does and when to use it (10 or more characters)');
  else if (m.description.includes('TODO(recipe)')) errors.push('recipe.json description still has the TODO(recipe) marker');
  const params = m.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    errors.push('params must be an object that maps each param name to its spec');
    return errors;
  }
  for (const [k, s] of Object.entries(params)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) errors.push('param name "' + k + '" must be a JS identifier');
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push('param "' + k + '" spec must be an object'); continue; }
    if (!PARAM_TYPES.includes(s.type)) errors.push('param "' + k + '" type must be one of ' + PARAM_TYPES.join(', '));
    if (s.required !== undefined && typeof s.required !== 'boolean') errors.push('param "' + k + '" required must be true or false');
    if (s.required && s.default !== undefined) errors.push('param "' + k + '" cannot be required and have a default');
    if (s.enum !== undefined && !Array.isArray(s.enum)) errors.push('param "' + k + '" enum must be an array');
  }
  return errors;
}

export function indexLines(recipes) {
  return recipes.map((r) => {
    const params = Object.entries(r.manifest.params || {}).map(([k, s]) => k + (s && s.required ? '*' : '')).join(', ');
    const tags = [r.scope, hasSideEffects(r) ? 'changes things' : null, r.loadError ? 'broken' : null].filter(Boolean).join(', ');
    const desc = String(r.manifest.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return '- ' + r.name + ' [' + tags + ']: ' + desc + (params ? ' · params: ' + params : '');
  });
}

/** Context text for SessionStart. Empty when there are no recipes, so the plugin costs nothing until it is used. */
export function indexText(recipes, max = 40) {
  if (!recipes.length) return '';
  const more = recipes.length > max ? ['- … ' + (recipes.length - max) + ' more: recipe list'] : [];
  return [
    'Executable recipes are installed (code-recipes plugin). When a task matches one, run it instead of redoing the work by hand:',
    "  recipe run <name> --json [--dry-run] --params '{\"key\":\"value\"}'",
    '  In Code Mode: await $\x60recipe run NAME --json --params $' + '{JSON.stringify(params)}\x60.nothrow().json()',
    '  Run a recipe marked "changes things" with --dry-run first and read its actions. (* = required param)',
    '  A [project] recipe comes from the repository: read it with recipe show <name> before its first run, as you would any script you did not write.',
    ...indexLines(recipes.slice(0, max)),
    ...more,
  ].join('\n');
}

// ---- captures ----

export function captureId(session, code) {
  return crypto.createHash('sha256').update(String(session) + '\0' + code).digest('hex').slice(0, 8);
}

function sessionFile(session) {
  return String(session || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) + '.jsonl';
}

export async function appendCapture(rec) {
  const dir = capturesDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.appendFile(path.join(dir, sessionFile(rec.session)), JSON.stringify(rec) + '\n', { mode: 0o600 });
}

const FINAL = new Set(['ok', 'error']);

/**
 * Reads captures and merges the records of one script (same session and code) into one entry.
 * A dispatch record keeps its eval number; a later final status (ok or error) wins.
 */
export async function readCaptures({ session, all = false } = {}) {
  const dir = capturesDir();
  let files;
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  if (!all) {
    if (session) files = files.filter((f) => f === sessionFile(session));
    else {
      const stats = await Promise.all(files.map(async (f) => [f, (await fs.stat(path.join(dir, f))).mtimeMs]));
      stats.sort((a, b) => b[1] - a[1]);
      files = stats.length ? [stats[0][0]] : [];
    }
  }
  const merged = new Map();
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.id || typeof r.code !== 'string') continue;
      const prev = merged.get(r.id);
      if (!prev) { merged.set(r.id, { ...r, firstTs: r.ts }); continue; }
      const status = FINAL.has(r.status) || !FINAL.has(prev.status) ? r.status : prev.status;
      merged.set(r.id, {
        ...prev, ...r, status,
        error: status === 'error' ? (r.error || prev.error) : undefined,
        firstTs: prev.firstTs,
        evalId: r.evalId ?? prev.evalId,
        description: r.description || prev.description,
      });
    }
  }
  return [...merged.values()].sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
}

/** Finds a capture by '#<eval number>' (latest wins) or by an id prefix of 4 or more characters. */
export function resolveCapture(ref, caps) {
  const r = String(ref).trim();
  const ev = r.match(/^#?(\d+)$/);
  if (ev && (r.startsWith('#') || r.length < 4)) {
    const hits = caps.filter((c) => String(c.evalId) === ev[1]);
    return hits.length ? hits[hits.length - 1] : null;
  }
  if (r.length < 4) throw new Error('capture id prefix "' + r + '" is too short; use 4 or more characters or #<eval>');
  const hits = caps.filter((c) => c.id.startsWith(r));
  if (hits.length > 1) throw new Error('capture id "' + r + '" matches ' + hits.length + ' captures; use more characters');
  return hits[0] || null;
}

const TRANSCRIPT_MAX = 64 * 1024 * 1024;

const RECEIPT_RE = /^\s*\(dispatched #(\d+)\)\s*$/;

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Walks one parsed transcript entry for a tool_result of toolUseId whose whole content is a receipt. */
function receiptIn(node, toolUseId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return null;
  if (!Array.isArray(node) && node.tool_use_id === toolUseId && node.type === 'tool_result') {
    const m = contentText(node.content).match(RECEIPT_RE);
    if (m) return Number(m[1]);
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = receiptIn(v, toolUseId, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

/** Maps each tool_use_id to the eval number of its receipt "(dispatched #N)" in the transcript text (JSON lines). */
export function evalIdsIn(text, toolUseIds) {
  const found = new Map();
  const pending = new Set(toolUseIds);
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && pending.size; i--) {
    const line = lines[i];
    let entry;
    for (const id of pending) {
      if (!line.includes(id)) continue;
      if (entry === undefined) { try { entry = JSON.parse(line); } catch { entry = null; } }
      const n = entry && receiptIn(entry, id);
      if (n != null) { found.set(id, n); pending.delete(id); }
    }
  }
  return found;
}

export function evalIdIn(text, toolUseId) {
  return evalIdsIn(text, [toolUseId]).get(toolUseId) ?? null;
}

async function readTail(file, max) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Fills evalId on captures that lack it, reading each transcript once (its last 64 MB).
 * The transcript format is not a public contract: when the receipt is not found, evalId stays null and the id still works.
 */
export async function fillEvalIds(caps, max = TRANSCRIPT_MAX) {
  const byTranscript = new Map();
  for (const c of caps) {
    if (c.evalId != null || !c.transcript || !c.toolUseId) continue;
    if (!byTranscript.has(c.transcript)) byTranscript.set(c.transcript, []);
    byTranscript.get(c.transcript).push(c);
  }
  for (const [transcript, list] of byTranscript) {
    let text;
    try { text = await readTail(transcript, max); } catch { continue; }
    const found = evalIdsIn(text, list.map((c) => c.toolUseId));
    for (const c of list) c.evalId = found.get(c.toolUseId) ?? null;
  }
  return caps;
}

export async function pruneCaptures(days = Number(process.env.RECIPES_CAPTURE_TTL_DAYS || 14)) {
  const dir = capturesDir();
  const cutoff = Date.now() - days * 86400000;
  let files;
  try { files = await fs.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    try {
      if ((await fs.stat(p)).mtimeMs < cutoff) { await fs.rm(p); removed++; }
    } catch { /* raced with another session */ }
  }
  return removed;
}
