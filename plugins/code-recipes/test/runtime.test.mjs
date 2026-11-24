import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createContext, validateParams, applyEdits, runRecipe } from '../lib/runtime.mjs';
import { tempDir, writeRecipe } from './helpers.mjs';

test('edit follows the REPL rules', async () => {
  const cwd = await tempDir();
  const { ctx } = createContext({ cwd });
  await ctx.write('f.txt', 'a b a\n');
  await assert.rejects(ctx.edit('f.txt', 'zz', 'y'), /anchor not found/);
  await assert.rejects(ctx.edit('f.txt', 'a', 'y'), /found 2 times/);
  assert.deepEqual(await ctx.edit('f.txt', 'b', '$&'), { ok: true, replacements: 1 });
  assert.equal(await ctx.file('f.txt').text(), 'a $& a\n');
  assert.deepEqual(await ctx.edit('f.txt', 'a', 'c', { all: true }), { ok: true, replacements: 2 });
  const soft = await ctx.edit('f.txt', 'nope', 'x', { soft: true });
  assert.equal(soft.ok, false);
  await assert.rejects(ctx.edit('f.txt', [['c $&', 'd'], ['missing', 'x']]), /anchor not found/);
  assert.equal(await ctx.file('f.txt').text(), 'c $& c\n', 'a failed batch writes nothing');
  assert.equal(applyEdits('xx', [['x', 'y']], true).text, 'yy');
});

test('dry run records write, edit and step without doing them', async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, 'keep.txt'), 'one\n');
  const { ctx, actions } = createContext({ cwd, dryRun: true });
  let ran = false;
  assert.equal(await ctx.write('new.txt', 'hello'), 5);
  await ctx.edit('keep.txt', 'one', 'two');
  await assert.rejects(ctx.edit('keep.txt', 'absent', 'x'), /anchor not found/);
  assert.equal(await ctx.step('deploy', () => { ran = true; }), undefined);
  assert.equal(ran, false);
  assert.equal(await ctx.file('new.txt').exists(), false);
  assert.equal(await ctx.file('keep.txt').text(), 'one\n');
  assert.deepEqual(actions.map((a) => [a.kind, a.skipped]), [['write', true], ['edit', true], ['step', true]]);
});

test('file helpers and preview', async () => {
  const cwd = await tempDir();
  const { ctx } = createContext({ cwd });
  await ctx.write('sub/l.txt', '1\n2\n3\n');
  assert.deepEqual(await ctx.file('sub/l.txt').lines(), ['1', '2', '3']);
  assert.equal(await ctx.file('sub/l.txt').slice(2, 1), '2');
  assert.match(ctx.preview('x'.repeat(300), 10), /^x{10}… \[290 more chars\]$/);
});

test('params are validated, coerced and defaulted', () => {
  const manifest = { params: {
    name: { type: 'string', required: true },
    n: { type: 'number', default: 2 },
    on: { type: 'boolean' },
    tags: { type: 'array', default: ['x'] },
    mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
  } };
  assert.deepEqual(validateParams(manifest, { name: 'z', n: '5', on: 'yes', tags: 'p, q' }),
    { name: 'z', n: 5, on: true, tags: ['p', 'q'], mode: 'a' });
  const d = validateParams(manifest, { name: 'z' });
  d.tags.push('changed');
  assert.deepEqual(validateParams(manifest, { name: 'z' }).tags, ['x'], 'defaults are copied');
  assert.throws(() => validateParams(manifest, {}), /missing required param "name"/);
  assert.throws(() => validateParams(manifest, { name: 'z', extra: 1 }), /unknown param "extra"/);
  assert.throws(() => validateParams(manifest, { name: 'z', n: 'abc' }), /expected a number/);
  assert.throws(() => validateParams(manifest, { name: 'z', mode: 'c' }), /must be one of/);
});

test('runRecipe reports failures instead of throwing and captures console', async () => {
  const root = await tempDir();
  const dir = await writeRecipe(root, 'boom', {
    params: { why: { type: 'string', default: 'bad' } },
    code: "export default async function main(params, { log }) { console.log('from console'); log('step', 1); throw new Error(params.why); }\n",
  });
  const rec = { name: 'boom', scope: 'user', dir, entry: dir + '/recipe.mjs', testFile: dir + '/test.mjs', manifest: JSON.parse(await fs.readFile(dir + '/recipe.json', 'utf8')) };
  const r = await runRecipe(rec, {}, { cwd: root, captureConsole: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'bad');
  assert.deepEqual(r.logs, ['from console', 'step 1']);
  const bad = await runRecipe(rec, { nope: 1 }, { cwd: root });
  assert.equal(bad.error.code, 'EPARAMS');
});
