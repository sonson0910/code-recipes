import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, run, BIN, PLUGIN } from './helpers.mjs';

const home = await tempDir();
const work = await tempDir();
const env = { RECIPES_HOME: home, CLAUDE_CODE_SESSION_ID: 'cli-sess', RECIPES_CAPTURE_DIR: '' };
delete process.env.RECIPES_CAPTURE_DIR;
const cli = (args, extra = {}) => run(BIN, args, { env: { ...env, ...extra }, cwd: work });

const captured = [
  "const name = 'Ann';",
  "await write('greeting.txt', 'hello ' + name + '\\n');",
  "const files = await $\x60ls\x60.lines();",
  "files",
].join('\n');

const finished = {
  json: { name: 'greet', description: 'Write greeting.txt for a person and list the folder. Used by the plugin tests.',
    params: { name: { type: 'string', required: true, description: 'who to greet' }, dir: { type: 'string', default: '.' } } },
  code: [
    "export default async function main(params, { $, write, file, log, dryRun }) {",
    "  const target = params.dir + '/greeting.txt';",
    "  await write(target, 'hello ' + params.name + '\\n');",
    "  const files = await $\x60ls \x24{params.dir}\x60.lines();",
    "  log('files', files.length);",
    "  return { target, exists: await file(target).exists(), files, dryRun };",
    "}",
    "",
  ].join('\n'),
  test: [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "export default [",
    "  { name: 'dry run plans one write', params: { name: 'Ann' }, check: ({ result, actions }) => {",
    "      assert.deepEqual(actions.map((a) => [a.kind, a.skipped]), [['write', true]]);",
    "      assert.equal(result.exists, false); } },",
    "  { name: 'real run writes the file', params: { name: 'Bo' }, dryRun: false, check: ({ result, tmp }) => {",
    "      assert.equal(result.exists, true);",
    "      assert.equal(fs.readFileSync(tmp + '/greeting.txt', 'utf8'), 'hello Bo\\n'); } },",
    "  { name: 'name is required', params: {}, expectError: /missing required param \"name\"/ },",
    "];",
    "",
  ].join('\n'),
};

test('capture -> new -> check -> test -> run', async () => {
  const hook = path.join(PLUGIN, 'hooks', 'capture.mjs');
  // As in a real session: one hook call when the script ends, the eval number only in the transcript's receipt.
  const transcript = path.join(await tempDir(), 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: '(dispatched #12)', is_error: false }] } }) + '\n');
  const payload = JSON.stringify({ session_id: 'cli-sess', tool_name: 'REPL', tool_use_id: 't1', cwd: work, transcript_path: transcript,
    tool_input: { code: captured, description: 'write a greeting' }, tool_response: { code: captured, result: '[ "greeting.txt" ]', stdout: '', stderr: '' } });
  await run('node', [hook], { input: payload, env });

  const caps = JSON.parse((await cli(['captures', '--json'])).stdout);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].status, 'ok');
  assert.match((await cli(['captures'])).stdout, /#12 +ok +4 /);
  assert.equal((await cli(['capture', '#12'])).stdout.split('\n').slice(1).join('\n').trim(), captured);

  const made = await cli(['new', 'greet', '--from', '#12']);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /Created user recipe "greet"/);
  const dir = path.join(home, 'greet');
  assert.match(await fs.readFile(path.join(dir, 'recipe.mjs'), 'utf8'), /^  const name = 'Ann';$/m);
  assert.equal((await cli(['new', 'greet', '--from', '#12'])).code, 1, 'refuses to overwrite');

  const unfinished = await cli(['check', 'greet']);
  assert.equal(unfinished.code, 1);
  assert.match(unfinished.stdout, /TODO\(recipe\)/);

  await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify(finished.json, null, 2));
  await fs.writeFile(path.join(dir, 'recipe.mjs'), finished.code);
  await fs.writeFile(path.join(dir, 'test.mjs'), finished.test);
  const checked = await cli(['check', 'greet']);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  const tested = await cli(['test', 'greet']);
  assert.equal(tested.code, 0, tested.stdout + tested.stderr);
  assert.match(tested.stdout, /3 passed, 0 failed/);

  const dry = await cli(['run', 'greet', '--json', '--dry-run', '-p', 'name=Cy']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const dr = JSON.parse(dry.stdout);
  assert.equal(dr.ok, true);
  assert.equal(dr.actions[0].skipped, true);
  assert.deepEqual(dr.logs, ['files 0']);
  await assert.rejects(fs.access(path.join(work, 'greeting.txt')));

  const real = JSON.parse((await cli(['run', 'greet', '--json', '--params', '{"name":"Cy"}'])).stdout);
  assert.equal(real.result.exists, true);
  assert.equal(await fs.readFile(path.join(work, 'greeting.txt'), 'utf8'), 'hello Cy\n');

  const human = await cli(['run', 'greet', '-p', 'name=Di', '--dry-run']);
  assert.match(human.stdout, /skipped write/);
  assert.match(human.stderr, /· files 1/);

  const wrong = await cli(['run', 'greet', '--json', '-p', 'nme=x']);
  assert.equal(wrong.code, 1);
  assert.equal(JSON.parse(wrong.stdout).error.code, 'EPARAMS');
  assert.equal((await cli(['run', 'nosuch'])).code, 1);
  assert.equal((await cli(['run'])).code, 2);
  assert.equal((await cli(['bogus'])).code, 2);

  const listed = JSON.parse((await cli(['list', '--json'])).stdout);
  assert.deepEqual(listed.map((r) => [r.name, r.changesThings]), [['greet', true]]);
});

test('session-start hook prints the index only when recipes exist', async () => {
  const hook = path.join(PLUGIN, 'hooks', 'session-start.mjs');
  const hookEnv = { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN };
  const input = JSON.stringify({ session_id: 'x', cwd: work, hook_event_name: 'SessionStart' });
  const first = await run('node', [hook], { env: hookEnv, input });
  assert.equal(first.code, 0);
  assert.match(first.stdout, /- greet \[user, changes things\]/);
  const empty = await run('node', [hook], { env: { ...hookEnv, RECIPES_HOME: await tempDir() }, input });
  assert.equal(empty.stdout, '');
});
