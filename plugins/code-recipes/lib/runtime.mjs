import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createShells, expandPath } from './shell.mjs';

/** Imports a module, reloading it when the file changed (recipes are edited and re-run in one process during tests). */
export async function importFresh(file) {
  const st = await fs.stat(file);
  return import(pathToFileURL(file).href + '?v=' + st.mtimeMs + '-' + st.size);
}

function splitLines(text) {
  const l = text.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}

const short = (s) => JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s);

/** Exact-string edits applied in order; a missing anchor, or a repeated one without all, throws before anything is written. */
export function applyEdits(text, pairs, all) {
  let out = text;
  let replacements = 0;
  for (const [oldText, newText] of pairs) {
    if (typeof oldText !== 'string' || oldText === '') throw new Error('edit: the anchor must be a non-empty string');
    const count = out.split(oldText).length - 1;
    if (count === 0) throw new Error('edit: anchor not found: ' + short(oldText));
    if (count > 1 && !all) throw new Error('edit: anchor found ' + count + ' times; pass {all: true} to replace every match: ' + short(oldText));
    out = all ? out.split(oldText).join(String(newText)) : out.replace(oldText, () => String(newText));
    replacements += all ? count : 1;
  }
  return { text: out, replacements };
}

/** The ctx a recipe receives. Every side effect goes into actions; in a dry run they are recorded and skipped. */
export function createContext({ cwd = process.cwd(), dryRun = false, env = {}, timeout, onLog } = {}) {
  const actions = [];
  const logs = [];
  const base = { cwd: path.resolve(cwd), env, timeout, dryRun, actions };
  const { $, mutate } = createShells(base);
  const resolve = (p) => expandPath(p, base.cwd);
  const record = (a) => { actions.push(dryRun ? { ...a, skipped: true } : a); };

  const log = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 120 }))).join(' ');
    logs.push(line);
    if (onLog) onLog(line);
  };

  const file = (p) => {
    const abs = resolve(p);
    const read = () => fs.readFile(abs, 'utf8');
    return {
      name: abs,
      text: read,
      json: async () => JSON.parse(await read()),
      lines: async () => splitLines(await read()),
      exists: () => fs.access(abs).then(() => true, () => false),
      slice: async (offset = 1, limit) => {
        const all = (await read()).split('\n');
        const start = Math.max(0, offset - 1);
        return all.slice(start, limit == null ? undefined : start + limit).join('\n');
      },
    };
  };

  const write = async (p, content) => {
    const abs = resolve(p);
    const text = String(content);
    const bytes = Buffer.byteLength(text);
    record({ kind: 'write', path: abs, bytes });
    if (!dryRun) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text);
    }
    return bytes;
  };

  const edit = async (p, a, b, c) => {
    const batch = Array.isArray(a);
    const pairs = batch ? a : [[a, b]];
    const opts = (batch ? b : c) || {};
    const abs = resolve(p);
    try {
      const before = await fs.readFile(abs, 'utf8');
      const { text, replacements } = applyEdits(before, pairs, Boolean(opts.all));
      record({ kind: 'edit', path: abs, replacements });
      if (!dryRun) await fs.writeFile(abs, text);
      return { ok: true, replacements };
    } catch (e) {
      if (opts.soft) return { ok: false, replacements: 0, error: e.message };
      throw e;
    }
  };

  const step = async (label, fn) => {
    record({ kind: 'step', label: String(label) });
    if (dryRun) return undefined;
    return fn();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const preview = (value, n = 200) => {
    let s;
    if (typeof value === 'string') s = value;
    else if (value && typeof value.stdout === 'string') s = value.stdout;
    else { try { s = JSON.stringify(value); } catch { s = String(value); } }
    s = String(s);
    return s.length > n ? s.slice(0, n) + '… [' + (s.length - n) + ' more chars]' : s;
  };

  const ctx = { $, mutate, step, edit, write, file, sleep, log, preview, dryRun, cwd: base.cwd };
  return { ctx, actions, logs };
}

function coerce(v, type) {
  switch (type) {
    case 'string':
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new Error('expected a string');
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
      throw new Error('expected a number');
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'off'].includes(s)) return false;
      }
      throw new Error('expected true or false');
    case 'array': {
      const a = typeof v === 'string' ? (v.trim().startsWith('[') ? JSON.parse(v) : v.split(',').map((x) => x.trim()).filter(Boolean)) : v;
      if (Array.isArray(a)) return a;
      throw new Error('expected an array (JSON or comma-separated)');
    }
    case 'object': {
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
      throw new Error('expected a JSON object');
    }
    default:
      throw new Error('unknown type ' + type);
  }
}

/** Checks input against recipe.json params: unknown names, missing required values, types (CLI strings are coerced), enums. */
export function validateParams(manifest, input = {}) {
  const spec = (manifest && manifest.params) || {};
  const names = Object.keys(spec);
  const problems = [];
  const out = {};
  for (const key of Object.keys(input)) {
    if (!(key in spec)) problems.push('unknown param "' + key + '"' + (names.length ? ' (known: ' + names.join(', ') + ')' : ' (this recipe takes no params)'));
  }
  for (const [key, s] of Object.entries(spec)) {
    let v = input[key];
    if (v === undefined) {
      if (s.default !== undefined) v = structuredClone(s.default);
      else {
        if (s.required) problems.push('missing required param "' + key + '"' + (s.description ? ': ' + s.description : ''));
        continue;
      }
    }
    try { v = coerce(v, s.type || 'string'); } catch (e) { problems.push('param "' + key + '": ' + e.message); continue; }
    if (Array.isArray(s.enum) && !s.enum.includes(v)) { problems.push('param "' + key + '" must be one of ' + JSON.stringify(s.enum)); continue; }
    out[key] = v;
  }
  if (problems.length) {
    const e = new Error('invalid params:\n  - ' + problems.join('\n  - '));
    e.code = 'EPARAMS';
    throw e;
  }
  return out;
}

function toPlain(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v))); } catch { return inspect(value, { depth: 4 }); }
}

function redirectConsole(log) {
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => log(...a); }
  return () => { Object.assign(console, saved); };
}

/** Runs a recipe and reports {ok, result, actions, logs, error}; it never throws for a recipe failure. */
export async function runRecipe(rec, input = {}, { dryRun = false, cwd = process.cwd(), onLog, captureConsole = false, timeout } = {}) {
  const started = Date.now();
  const report = { ok: false, recipe: rec.name, scope: rec.scope, dryRun: Boolean(dryRun), params: null, result: null, actions: [], logs: [] };
  let restore = () => {};
  try {
    if (rec.loadError) throw new Error(rec.loadError);
    report.params = validateParams(rec.manifest, input);
    const mod = await importFresh(rec.entry);
    if (typeof mod.default !== 'function') throw new Error(rec.entry + ' must export default async function main(params, ctx)');
    const { ctx, actions, logs } = createContext({ cwd, dryRun, onLog, timeout });
    report.actions = actions;
    report.logs = logs;
    if (captureConsole) restore = redirectConsole(ctx.log);
    report.result = toPlain(await mod.default(report.params, ctx));
    report.ok = true;
  } catch (e) {
    report.error = { name: (e && e.name) || 'Error', message: String(e && e.message !== undefined ? e.message : e) };
    if (e && e.exitCode !== undefined) report.error.exitCode = e.exitCode;
    if (e && e.code) report.error.code = e.code;
    if (process.env.RECIPES_DEBUG && e && e.stack) report.error.stack = e.stack;
  } finally {
    restore();
  }
  report.ms = Date.now() - started;
  return report;
}

/**
 * Runs the cases exported by test.mjs. Each case gets a fresh temp directory that is also the recipe's cwd.
 * Case fields: name, params, dryRun (default true), cwd, setup({tmp, ...ctx}) -> extra params, expectError, check(report + {tmp}).
 */
export async function runTests(rec, { onCase } = {}) {
  const summary = { recipe: rec.name, passed: 0, failed: 0, cases: [] };
  let cases;
  try {
    cases = (await importFresh(rec.testFile)).default;
    if (!Array.isArray(cases) || cases.length === 0) throw new Error('test.mjs must export default a non-empty array of cases');
  } catch (e) {
    summary.failed = 1;
    summary.cases.push({ name: '(load test.mjs)', ok: false, error: e.message });
    return summary;
  }
  for (const [i, c] of cases.entries()) {
    const name = (c && c.name) || 'case ' + (i + 1);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-test-'));
    const started = Date.now();
    let entry;
    try {
      let params = { ...(c.params || {}) };
      if (typeof c.setup === 'function') {
        const { ctx } = createContext({ cwd: tmp });
        const extra = await c.setup({ ...ctx, tmp });
        if (extra && typeof extra === 'object') params = { ...params, ...extra };
      }
      const res = await runRecipe(rec, params, { dryRun: c.dryRun ?? true, cwd: c.cwd ? expandPath(c.cwd, tmp) : tmp, captureConsole: true });
      if (c.expectError) {
        if (res.ok) throw new Error('expected the recipe to fail, but it succeeded');
        const msg = res.error.message;
        if (c.expectError instanceof RegExp && !c.expectError.test(msg)) throw new Error('error ' + JSON.stringify(msg) + ' does not match ' + c.expectError);
        if (typeof c.expectError === 'string' && !msg.includes(c.expectError)) throw new Error('error ' + JSON.stringify(msg) + ' does not contain ' + JSON.stringify(c.expectError));
      } else if (!res.ok) {
        throw new Error('recipe failed: ' + res.error.message);
      }
      if (typeof c.check === 'function') await c.check({ ...res, tmp });
      entry = { name, ok: true, ms: Date.now() - started };
    } catch (e) {
      entry = { name, ok: false, error: (e && e.message) || String(e), ms: Date.now() - started };
    } finally {
      if (!process.env.RECIPES_KEEP_TMP) await fs.rm(tmp, { recursive: true, force: true });
    }
    summary.cases.push(entry);
    if (entry.ok) summary.passed++; else summary.failed++;
    if (onCase) onCase(entry);
  }
  return summary;
}
