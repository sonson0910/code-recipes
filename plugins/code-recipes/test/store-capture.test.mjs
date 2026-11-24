import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, run, writeRecipe, PLUGIN } from './helpers.mjs';

const home = await tempDir();
process.env.RECIPES_HOME = home;
delete process.env.RECIPES_CAPTURE_DIR;
const store = await import('../lib/store.mjs');
const { captureRecord } = await import('../hooks/capture.mjs');

const ev = (resp, extra = {}) => ({
  session_id: 'sess-1', tool_name: 'REPL', tool_use_id: 'tu-1', cwd: '/w',
  tool_input: { code: 'const a = 1;\na', description: 'add numbers' }, tool_response: resp, ...extra,
});

test('captureRecord maps dispatch, success, error and other tools', () => {
  const d = captureRecord(ev({ result: '(dispatched #7)', code: 'x' }));
  assert.equal(d.status, 'dispatched');
  assert.equal(d.evalId, 7);
  assert.equal(d.lines, 2);
  assert.equal(captureRecord(ev({ result: 'done', toolsUsed: ['Bash'] })).status, 'ok');
  const e = captureRecord(ev({ result: '', error: 'ReferenceError: x is not defined' }));
  assert.equal(e.status, 'error');
  assert.match(e.error, /ReferenceError/);
  assert.equal(captureRecord(ev('(dispatched #3)')).evalId, 3);
  assert.equal(captureRecord(ev({ result: 'a result that mentions (dispatched #26) in passing' })).evalId, null);
  assert.equal(captureRecord({ ...ev({}), tool_name: 'Bash' }), null);
  assert.equal(captureRecord(ev({}, { tool_input: { code: '   ' } })), null);
  assert.equal(d.id, captureRecord(ev({ result: 'done' })).id, 'same session and code give the same id');
});

test('eval numbers are filled from the receipts in the transcript', async () => {
  const dir = await tempDir();
  const tx = path.join(dir, 't.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  const text =
    line({ type: 'user', message: { content: [{ tool_use_id: 'tu-9', type: 'tool_result', content: '(dispatched #41)', is_error: false }] } }) +
    line({ type: 'progress', data: { tool_use_id: 'tu-9', inner_call_index: 0 } }) +
    line({ type: 'user', message: { content: [{ tool_use_id: 'tu-other', type: 'tool_result', content: '(dispatched #42)' }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'says (dispatched #43) but is output', tool_use_id: 'tu-10' }] } });
  await fs.writeFile(tx, text);
  assert.equal(store.evalIdIn(text, 'tu-9'), 41);
  assert.equal(store.evalIdIn(text, 'tu-10'), null);
  const reshaped = line({ content: [{ content: [{ type: 'text', text: '(dispatched #7)' }], type: 'tool_result', tool_use_id: 'tu-a' }] }) +
    JSON.stringify({ x: { tool_use_id: 'tu-b', type: 'tool_result', content: '(dispatched #8)' } }, null, 0).replace(/":/g, '": ') + '\n';
  assert.equal(store.evalIdIn(reshaped, 'tu-a'), 7, 'array content, other key order');
  assert.equal(store.evalIdIn(reshaped, 'tu-b'), 8, 'whitespace after colons');
  const caps = [
    { toolUseId: 'tu-9', transcript: tx, evalId: null },
    { toolUseId: 'tu-other', transcript: tx, evalId: null },
    { toolUseId: 'tu-missing', transcript: tx, evalId: null },
    { toolUseId: 'tu-9', transcript: path.join(dir, 'absent.jsonl'), evalId: null },
    { toolUseId: 'tu-9', transcript: tx, evalId: 5 },
  ];
  await store.fillEvalIds(caps);
  assert.deepEqual(caps.map((c) => c.evalId), [41, 42, null, null, 5]);
  const tail = [{ toolUseId: 'tu-9', transcript: tx, evalId: null }];
  await store.fillEvalIds(tail, 40);
  assert.equal(tail[0].evalId, null, 'outside the tail window');
});

test('the hook appends privately, merges records and never fails', async () => {
  const hook = path.join(PLUGIN, 'hooks', 'capture.mjs');
  const a = await run('node', [hook], { input: JSON.stringify(ev({ result: '(dispatched #9)' })) });
  const b = await run('node', [hook], { input: JSON.stringify(ev({ result: 'final value' })) });
  const bad = await run('node', [hook], { input: 'not json' });
  for (const r of [a, b, bad]) { assert.equal(r.code, 0); assert.equal(r.stdout, ''); }
  const file = path.join(home, '.captures', 'sess-1.jsonl');
  assert.equal(((await fs.stat(file)).mode & 0o777), 0o600);
  assert.equal(((await fs.stat(path.dirname(file))).mode & 0o777), 0o700);
  const caps = await store.readCaptures({ session: 'sess-1' });
  assert.equal(caps.length, 1);
  assert.equal(caps[0].status, 'ok');
  assert.equal(caps[0].evalId, 9);
  assert.equal(store.resolveCapture('#9', caps).id, caps[0].id);
  assert.equal(store.resolveCapture(caps[0].id.slice(0, 5), caps).id, caps[0].id);
  assert.throws(() => store.resolveCapture('ab', caps), /too short/);
});

test('a later dispatch record does not hide a final status', async () => {
  await store.appendCapture({ ...captureRecord(ev({ result: 'done' }, { session_id: 's2' })), ts: '2026-01-01T00:00:01Z' });
  await store.appendCapture({ ...captureRecord(ev({ result: '(dispatched #4)' }, { session_id: 's2' })), ts: '2026-01-01T00:00:02Z' });
  const [c] = await store.readCaptures({ session: 's2' });
  assert.equal(c.status, 'ok');
  assert.equal(c.evalId, 4);
});

test('old capture files are pruned', async () => {
  const old = path.join(home, '.captures', 'old.jsonl');
  await fs.writeFile(old, '');
  const t = new Date(Date.now() - 30 * 86400000);
  await fs.utimes(old, t, t);
  assert.equal(await store.pruneCaptures(14), 1);
  await assert.rejects(fs.access(old));
});

test('manifest validation and index text', async () => {
  assert.deepEqual(store.validateManifest({ name: 'ok-name', description: 'Does a useful thing.', params: { x: { type: 'string' } } }, 'ok-name'), []);
  const errs = store.validateManifest({ name: 'Bad', description: 'short', params: { 'a-b': { type: 'date', required: true, default: 1 } } }, 'other');
  assert.ok(errs.length >= 5, errs.join('\n'));
  assert.equal(store.indexText([]), '');
  const project = await tempDir();
  await fs.mkdir(path.join(project, '.claude', 'recipes'), { recursive: true });
  await writeRecipe(path.join(project, '.claude', 'recipes'), 'shared', { code: 'export default async () => 1;\n' });
  await writeRecipe(home, 'shared', { description: 'User copy that the project copy hides.', code: 'export default async () => 2;\n' });
  await writeRecipe(home, 'writer', { params: { p: { type: 'string', required: true } }, code: "export default async (params, { write }) => write('x', params.p);\n" });
  const list = await store.listRecipes(project);
  assert.deepEqual(list.map((r) => [r.name, r.scope]), [['shared', 'project'], ['writer', 'user']]);
  const text = store.indexText(list);
  assert.match(text, /- shared \[project\]/);
  assert.match(text, /- writer \[user, changes things\]: .* params: p\*/);
});
