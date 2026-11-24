import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, quoteArg, lenientExit1, mutationReason, createShells, DryRunGuardError, ShellError } from '../lib/shell.mjs';
import { tempDir } from './helpers.mjs';

const tpl = (strings, ...values) => buildCommand(strings, values);

test('values are quoted as single arguments, arrays per item, raw spliced', () => {
  assert.equal(quoteArg("it's"), "'it'\\''s'");
  assert.equal(tpl`echo ${"a b; rm -rf /"}`, "echo 'a b; rm -rf /'");
  assert.equal(tpl`ls ${['x y', 'z']}`, "ls 'x y' 'z'");
  assert.equal(tpl`echo ${{ raw: '$HOME' }}`, 'echo $HOME');
  assert.equal(tpl`echo \`date\` \${X}`, 'echo \x60date\x60 $' + '{X}');
});

test('exit 1 from grep-like commands is an answer, other failures throw', async () => {
  const cwd = await tempDir();
  const { $ } = createShells({ cwd, actions: [] });
  const g = await $`printf 'a\n' | grep zzz`;
  assert.equal(g.exitCode, 1);
  assert.match(g.note, /grep/);
  await assert.rejects($`exit 3`, (e) => e instanceof ShellError && e.exitCode === 3);
  const n = await $`echo out; echo err >&2; exit 4`.nothrow();
  assert.equal(n.exitCode, 4);
  assert.deepEqual(n.lines(), ['out', 'err']);
  assert.equal(lenientExit1('git -C repo diff --quiet'), 'git diff exited 1');
  assert.equal(lenientExit1('false'), null);
});

test('chained options, string form, json and timeout', async () => {
  const cwd = await tempDir();
  const { $ } = createShells({ cwd, actions: [] });
  assert.equal((await $`pwd`.text()).trim(), cwd);
  assert.equal(await $`echo $FOO`.env({ FOO: 'bar' }).text(), 'bar\n');
  assert.deepEqual(await $`echo '{"a":1}'`.json(), { a: 1 });
  assert.equal(await $('echo plain', 5000).text(), 'plain\n');
  await assert.rejects($`sleep 5`.timeout(200), /timed out/);
});

test('mutation heuristic flags writes and ignores reads and quoted text', () => {
  for (const c of ['rm -rf build', 'echo hi > out.txt', 'git push origin main', 'git -C x commit -m wip', 'npm install',
    'curl -X POST https://x', 'kubectl apply -f k.yaml', 'sed -i s/a/b/ f', 'tar -xzf a.tgz', 'gh pr create --fill',
    'docker compose up -d', "psql -c 'drop table t'", 'mkdir -p out']) {
    assert.ok(mutationReason(c), 'should flag: ' + c);
  }
  for (const c of ['ls -la', 'git status', 'git log --oneline -5', "grep -n 'rm -rf' notes.txt", 'cat a 2>/dev/null',
    'echo x 2>&1', 'gh pr list --json number', 'kubectl get pods', 'tar -tzf a.tgz', 'git diff --stat', 'curl -s https://x']) {
    assert.equal(mutationReason(c), null, 'should not flag: ' + c);
  }
});

test('dry run: $ refuses writes unless readonly, mutate records and skips', async () => {
  const cwd = await tempDir();
  const actions = [];
  const { $, mutate } = createShells({ cwd, actions, dryRun: true });
  await assert.rejects($`touch made`, DryRunGuardError);
  const r = await $`echo kept > /dev/null; echo ok`.text();
  assert.equal(r, 'ok\n');
  assert.equal((await $`echo x | tee /dev/null`.readonly().text()), 'x\n');
  const m = await mutate`touch made`;
  assert.equal(m.stdout, '');
  assert.equal(m.json(), null);
  assert.deepEqual(actions, [{ kind: 'shell', command: 'touch made', cwd, skipped: true }]);
  assert.equal((await $`ls`.text()), '');
});

test('real run: mutate executes and is recorded', async () => {
  const cwd = await tempDir();
  const actions = [];
  const { $, mutate } = createShells({ cwd, actions, dryRun: false });
  await mutate`touch made`;
  assert.equal((await $`ls`.text()), 'made\n');
  assert.equal(actions[0].skipped, undefined);
});
