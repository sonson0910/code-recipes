import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, run, writeRecipe, PLUGIN, BIN } from './helpers.mjs';

const home = await tempDir();
const work = await tempDir();
process.env.RECIPES_HOME = home;
delete process.env.RECIPES_CAPTURE_DIR;
delete process.env.RECIPES_AUTOSAVE;
delete process.env.RECIPES_SIMILARITY;
const store = await import('../lib/store.mjs');
const sim = await import('../lib/similarity.mjs');
const { stopMessage } = await import('../hooks/stop.mjs');

const CAPTURE = path.join(PLUGIN, 'hooks', 'capture.mjs');
const STOP = path.join(PLUGIN, 'hooks', 'stop.mjs');

const deployA = [
  "const branch = 'feature-login';",
  "await sh('cd /srv/shop && git fetch origin && git checkout ' + branch);",
  "const build = await sh('cd /srv/shop && docker compose -f compose.preview.yml build web worker');",
  "if (build.exitCode) throw new Error('preview build failed');",
  "await sh('cd /srv/shop && docker compose -f compose.preview.yml up -d web worker');",
  "const health = await sh('curl -fsS https://preview.example.test/healthz');",
  "log('deployed preview', branch, health);",
].join('\n');
const deployB = deployA.replace("'feature-login'", "'fix-billing-totals'").replace(/branch/g, 'ref')
  + "\nawait sh('cd /srv/shop && docker compose -f compose.preview.yml ps');";
const deployB2 = deployB + "\nlog('preview url', 'https://preview.example.test');";
const outdated = [
  "const pkg = JSON.parse(await file('package.json').text());",
  "const deps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));",
  "const report = await sh('npm outdated --json --long');",
  "const rows = Object.entries(JSON.parse(report || '{}')).map(([name, v]) => [name, v.current, v.wanted, v.latest, v.type]);",
  "const majors = rows.filter((r) => r[1] && r[3] && r[1].split('.')[0] !== r[3].split('.')[0]);",
  "({ total: deps.length, outdated: rows.length, majors: majors.map((r) => r[0] + ' ' + r[1] + ' -> ' + r[3]) })",
].join('\n');
const backup = [
  "const stamp = new Date().toISOString().slice(0, 10);",
  "await sh('pg_dump --format=custom --file /backups/shop-' + stamp + '.dump shop');",
  "await sh('rclone copy /backups/shop-' + stamp + '.dump remote:db-backups --checksum');",
  "const listing = await sh('rclone lsl remote:db-backups');",
  "const kept = listing.split('\\n').filter((l) => l.includes('shop-')).length;",
  "log('backup uploaded', stamp, 'copies kept', kept);",
].join('\n');

let call = 0;
const prints = async () => {
  try {
    return (await fs.readFile(path.join(home, '.captures', 'fingerprints.ndjson'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  } catch { return []; }
};
/** Runs the capture hook; resolves the fingerprint it wrote for this script (undefined when none) and the note it printed. */
async function capture(session, code, { description = '', error, env = {} } = {}) {
  const ev = {
    session_id: session, tool_name: 'REPL', tool_use_id: 'tu-' + (++call), cwd: work,
    tool_input: { code, description }, tool_response: error ? { result: '', error } : { result: 'done' },
  };
  const r = await run('node', [CAPTURE], { input: JSON.stringify(ev), env });
  assert.equal(r.code, 0);
  const id = store.captureId(session, code);
  const fp = (await prints()).reverse().find((p) => p.id === id);
  return { fp, note: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null };
}

async function stop(session, extra = {}, env = {}) {
  const r = await run('node', [STOP], { input: JSON.stringify({ session_id: session, hook_event_name: 'Stop', stop_hook_active: false, ...extra }), env });
  assert.equal(r.code, 0);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('features drop keywords, comments and numbers; the MinHash estimate tracks Jaccard', () => {
  const f = sim.features("// deploy it\nconst x = await sh('docker compose up 42'); /* note */ return x;");
  assert.ok(f.has('docker') && f.has('compose') && f.has('docker compose') && f.has('sh'));
  for (const w of ['const', 'await', 'return', 'deploy', 'note', '42']) assert.ok(!f.has(w), w);
  for (const [a, b] of [[deployA, deployB], [deployA, outdated], [deployB, deployB2], [outdated, backup]]) {
    const fa = sim.features(a);
    const fb = sim.features(b);
    assert.ok(Math.abs(sim.jaccard(fa, fb) - sim.similarity(sim.signature(fa), sim.signature(fb))) < 0.15);
  }
  const sig = sim.signature(sim.features(deployA));
  assert.equal(sig.length, 344);
  assert.equal(sim.similarity(sig, sig), 1);
  assert.ok(sim.similarity(sig, sim.signature(sim.features(outdated))) < 0.2);
  assert.ok(sim.similarity(sig, sim.signature(sim.features(deployB))) >= store.similarityThreshold());
  assert.equal(sim.similarity('short', 'short'), 0);
  assert.equal(sim.similarity('ab'.repeat(256), 'ab'.repeat(256)), 0, 'not a signature');
});

test('a script that repeats another session is reported once, at Stop', async () => {
  const { fp: a } = await capture('s1', deployA, { description: 'Deploy preview' });
  assert.equal(a.repeats, undefined, 'nothing earlier');
  assert.equal(a.code, undefined, 'fingerprints keep no code');

  assert.equal((await capture('s2', deployB, { error: 'Error: build failed' })).fp, undefined, 'a failed script is not fingerprinted');
  const { fp: b } = await capture('s2', deployB + '\n// first try', { description: 'Deploy preview again' });
  assert.deepEqual(b.repeats.map((r) => r.id), [a.id]);
  assert.ok(b.repeats[0].score >= 0.45);
  const { fp: b2, note } = await capture('s2', deployB2, { description: 'Deploy preview, show url' });
  assert.equal(note, null, 'no output without a recipe');
  assert.deepEqual(b2.repeats.map((r) => r.id), [a.id], 'a run minutes earlier in the same session is a retry, not a repeat');

  assert.equal((await capture('s2', outdated)).fp.repeats, undefined, 'unrelated work');
  assert.equal((await capture('s2', "await sh('git status');")).fp, undefined, 'too small');
  assert.equal((await capture('s2', deployA + "\nawait sh('recipe run deploy-preview');")).fp, undefined, 'recipe work');

  assert.equal(await stop('s2', { stop_hook_active: true }), null, 'no second continuation');
  const out = await stop('s2');
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  const msg = out.hookSpecificOutput.additionalContext;
  assert.match(msg, new RegExp(b2.id + ' "Deploy preview, show url" repeats ' + a.id + ' "Deploy preview"'));
  assert.ok(msg.includes('recipe new <name> --from ' + b2.id + ',' + a.id), msg);
  assert.ok(!msg.includes(b.id + ' '), 'one report per earlier run, the latest wins');
  assert.match(msg, /without asking the user/);
  assert.match(msg, /recipe dismiss <id>/);
  assert.equal(await stop('s2'), null, 'reported once');
  assert.equal(await stop('s1'), null, 'nothing to report');

  assert.equal((await capture('s3', deployB2 + "\nlog('again');", { env: { RECIPES_AUTOSAVE: '0' } })).fp, undefined, 'RECIPES_AUTOSAVE=0 turns it off');
});

test('the same session counts when the earlier run is hours old', async () => {
  const sig = sim.signature(sim.features(deployA));
  const now = Date.parse('2026-01-01T12:00:00Z');
  const earlier = (h) => ({ id: 'e' + h, session: 'long', status: 'ok', n: 30, sig, ts: new Date(now - h * 3600000).toISOString() });
  const fp = { id: 'cur', session: 'long', ts: new Date(now).toISOString(), sig };
  assert.deepEqual((await store.findRepeats(fp, { cwd: work, prints: [earlier(0.5)] })).repeats, []);
  assert.deepEqual((await store.findRepeats(fp, { cwd: work, prints: [earlier(3)] })).repeats.map((r) => r.id), ['e3']);
});

test('reports are capped per Stop and spaced out', async () => {
  const sig = sim.signature(sim.features(outdated));
  const file = path.join(home, '.captures', 'fingerprints.ndjson');
  const t0 = Date.parse('2026-02-01T00:00:00Z');
  for (let i = 1; i <= 3; i++) {
    const row = { v: 2, id: 'cap' + i, session: 'busy', ts: new Date(t0).toISOString(), n: 30, sig,
      repeats: [{ id: 'old' + i, session: 'past', ts: '2026-01-20T00:00:00Z', score: 0.5 + i / 10 }] };
    await fs.appendFile(file, JSON.stringify(row) + '\n');
  }
  const first = await store.takeUnreportedRepeats('busy', t0);
  assert.deepEqual(first.map((p) => p.id), ['cap3', 'cap2'], 'best two first');
  assert.equal(first[0].repeats[0].captured, false, 'the earlier session has no capture file');
  assert.deepEqual(await store.takeUnreportedRepeats('busy', t0 + 60000), [], 'cooldown');
  assert.deepEqual((await store.takeUnreportedRepeats('busy', t0 + store.REPORT_COOLDOWN_MS)).map((p) => p.id), ['cap1']);
  assert.deepEqual(await store.takeUnreportedRepeats('busy', t0 + 3 * store.REPORT_COOLDOWN_MS), []);
});

test('dismissed scripts are not suggested again; scripts a recipe already does get a reuse note', async () => {
  const b2 = (await store.readCaptures({ session: 's2' })).find((c) => c.code === deployB2);
  const r = await run(BIN, ['dismiss', b2.id.slice(0, 6)], { env: { CLAUDE_CODE_SESSION_ID: 's9' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /will not be suggested/);
  const dismissed = await capture('s4', deployB2 + "\nlog('one more');");
  assert.equal(dismissed.fp.repeats, undefined, 'dismissed');
  assert.equal(dismissed.fp.recipe, undefined);
  assert.equal((await run(BIN, ['dismiss'])).code, 2);

  const { fp: d } = await capture('s5', backup);
  const { fp: e } = await capture('s6', backup.replace('--checksum', '--checksum --transfers 2'));
  assert.deepEqual(e.repeats.map((x) => x.id), [d.id]);
  await writeRecipe(home, 'db-backup', { code: 'export default async function () { return 1; }\n', test: 'export default [];\n' });
  const manifest = JSON.parse(await fs.readFile(path.join(home, 'db-backup', 'recipe.json'), 'utf8'));
  manifest.source = { captures: [{ id: d.id }] };
  await fs.writeFile(path.join(home, 'db-backup', 'recipe.json'), JSON.stringify(manifest));
  const viaSource = await capture('s7', backup + "\nlog('done');");
  assert.equal(viaSource.fp.repeats, undefined, 'its earlier run is the source of a recipe');
  assert.equal(viaSource.fp.recipe.name, 'db-backup');
  assert.equal(viaSource.note.hookEventName, 'PostToolUse');
  assert.match(viaSource.note.additionalContext, /recipe "db-backup" does .*recipe run db-backup/);

  await writeRecipe(home, 'outdated-deps', { code: outdated, test: 'export default [];\n' });
  const viaCode = await capture('s8', outdated + "\nlog('checked');");
  assert.equal(viaCode.fp.recipe.name, 'outdated-deps', 'a recipe with alike code already does this');
  assert.equal(await stop('s8'), null, 'nothing to save');
});

test('stopMessage: references, ages, scaffold commands and the ask mode', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  const p = { id: 'aaaa1111', evalId: 12, description: 'Deploy', repeats: [
    { id: 'bbbb2222', ts: '2026-01-01T01:00:00Z', score: 0.71, description: 'Deploy before', captured: true },
    { id: 'cccc3333', ts: '2025-12-01T00:00:00Z', score: 0.5, captured: false },
  ] };
  const msg = stopMessage([p], now);
  assert.match(msg, /- #12 aaaa1111 "Deploy" repeats bbbb2222 "Deploy before", 47 hours ago, 71% alike; cccc3333, 33 days ago, 50% alike\./);
  assert.ok(msg.includes('recipe new <name> --from aaaa1111,bbbb2222`'), 'only earlier runs whose capture is kept');
  const ask = stopMessage([p], now, 'ask');
  assert.match(ask, /ask the user in one short question/);
  assert.ok(!ask.includes('without asking the user'));
});

test('pruning keeps fingerprints for 60 days and drops older ones', async () => {
  const file = path.join(home, '.captures', 'fingerprints.ndjson');
  const sig = sim.signature(sim.features(deployA));
  const day = 86400000;
  await fs.appendFile(file, JSON.stringify({ id: 'old00001', session: 'old', ts: new Date(Date.now() - 90 * day).toISOString(), n: 30, sig }) + '\n');
  await fs.appendFile(file, JSON.stringify({ id: 'mid00001', session: 'old', ts: new Date(Date.now() - 30 * day).toISOString(), n: 30, sig }) + '\n');
  await fs.writeFile(path.join(home, '.captures', 'old.state.json'), '{}');
  const t = new Date(Date.now() - 30 * day);
  await fs.utimes(path.join(home, '.captures', 'old.state.json'), t, t);
  await store.pruneCaptures(14);
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('old00001'));
  assert.ok(text.includes('mid00001'), 'older than the capture TTL but within 60 days');
  assert.equal(((await fs.stat(file)).mode & 0o777), 0o600);
  await assert.rejects(fs.access(path.join(home, '.captures', 'old.state.json')));
});
