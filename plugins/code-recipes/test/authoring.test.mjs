import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeCode, scaffold, checkRecipe } from '../lib/authoring.mjs';
import { loadRecipe } from '../lib/store.mjs';
import { tempDir, writeRecipe } from './helpers.mjs';

test('analyzeCode finds writes through $ and REPL-only calls', () => {
  const code = [
    "const files = await $\x60ls\x60.lines();",
    "await $\x60rm -rf \x24{dir}\x60;",
    "await $\x60echo x > out.txt\x60.readonly();",
    "await mutate\x60git push\x60;",
    "const page = await tools.Read({ file_path: 'x' });",
    "await Agent({ prompt: 'x' });",
  ].join('\n');
  const { mutations, replOnly } = analyzeCode(code);
  assert.deepEqual(mutations.map((m) => m.line), [2]);
  assert.deepEqual(replOnly.map((r) => r.line).sort(), [5, 6]);
});

test('a scaffold fails check until it is finished, then passes', async () => {
  const root = await tempDir();
  const files = scaffold({ name: 'demo', code: "const out = await $\x60echo hi\x60.text();\nout", source: { file: 'x' } });
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify(files.manifest));
  await fs.writeFile(path.join(dir, 'recipe.mjs'), files.recipe);
  await fs.writeFile(path.join(dir, 'test.mjs'), files.test);
  const first = await checkRecipe(await loadRecipe(dir, 'user'));
  assert.equal(first.ok, false);
  assert.ok(first.errors.some((e) => e.includes('recipe.mjs still has')));
  assert.ok(first.errors.some((e) => e.includes('test.mjs still has')));
  assert.ok(first.errors.some((e) => e.includes('description')));

  await writeRecipe(root, 'demo', {
    description: 'Echo a greeting; used to test the checker.',
    params: { who: { type: 'string', default: 'you' }, unused: { type: 'number' } },
    code: "export default async function main(params, { $ }) {\n  return (await $\x60echo hi \x24{params.who}\x60.text()).trim();\n}\n",
    test: "export default [{ name: 'greets', params: { who: 'Al' }, check: ({ result }) => { if (result !== 'hi Al') throw new Error(result); } }];\n",
  });
  const second = await checkRecipe(await loadRecipe(dir, 'user'));
  assert.deepEqual(second.errors, []);
  assert.ok(second.warnings.some((w) => w.includes('"unused"')));

  await writeRecipe(root, 'demo', {
    description: 'Reads an undeclared param and calls a REPL tool.',
    code: "export default async function main(params) {\n  return tools.Read({ file_path: params.path });\n}\n",
    test: "export default [{ name: 'x' }];\n",
  });
  const third = await checkRecipe(await loadRecipe(dir, 'user'));
  assert.ok(third.errors.some((e) => e.includes('params.path')));
  assert.ok(third.errors.some((e) => e.includes('only available inside the REPL')));
});

test('check finds a secret in a recipe', async () => {
  const root = await tempDir();
  const fake = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const dir = await writeRecipe(root, 'leaky', {
    description: 'Has a token pasted in by mistake.',
    code: "export default async function main() {\n  return '" + fake + "';\n}\n",
    test: "export default [{ name: 'x' }];\n",
  });
  const r = await checkRecipe(await loadRecipe(dir, 'user'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /secret|GitHub token/.test(e)), r.errors.join('\n'));
});
