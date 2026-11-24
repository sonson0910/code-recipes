import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(PLUGIN, 'bin', 'recipe');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

export async function tempDir(prefix = 'recipes-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Runs a node script or the CLI with stdin and env; resolves {code, stdout, stderr}. */
export function run(cmd, args, { env = {}, input = '', cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Writes a finished recipe: name, manifest fields and the code of recipe.mjs and test.mjs. */
export async function writeRecipe(root, name, { description = 'A recipe used by the plugin test suite.', params = {}, code, test }) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ name, description, params }, null, 2));
  await fs.writeFile(path.join(dir, 'recipe.mjs'), code);
  if (test !== undefined) await fs.writeFile(path.join(dir, 'test.mjs'), test);
  return dir;
}
