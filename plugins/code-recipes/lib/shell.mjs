import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 600000;
const MAX_BUFFER = 64 * 1024 * 1024;
const LENIENT_EXIT1 = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '[']);
const active = new Set();

/** Expands a leading ~ and resolves the path against base. */
export function expandPath(p, base = process.cwd()) {
  let s = String(p);
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(base, s);
}

/** Single-quotes one value so the shell sees it as one literal argument. */
export function quoteArg(value) {
  const s = value == null ? '' : String(value);
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** How an interpolated value enters a command: one quoted argument, one per array item, or {raw} spliced as is. */
export function interpolate(value) {
  if (Array.isArray(value)) return value.map(quoteArg).join(' ');
  if (value && typeof value === 'object' && typeof value.raw === 'string') return value.raw;
  return quoteArg(value);
}

/** Template text reaches the shell as written; only an escaped backtick or dollar-brace loses its backslash (same as the REPL). */
export function buildCommand(strings, values) {
  let out = '';
  for (let i = 0; i < strings.raw.length; i++) {
    out += strings.raw[i].replace(/\\\x60/g, '\x60').replace(/\\\$\{/g, '$' + '{');
    if (i < values.length) out += interpolate(values[i]);
  }
  return out;
}

function lastCommandWords(command) {
  const lines = String(command).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const parts = last.split(/\|\||&&|[;|]/);
  const words = (parts[parts.length - 1] || '').trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  while (words.length && ['sudo', 'command', 'exec', 'time', 'nice', 'env'].includes(words[0])) words.shift();
  return words;
}

/** Exit 1 from these commands is an answer (no match, files differ, a false test), not a failure. Mirrors the REPL. */
export function lenientExit1(command) {
  const w = lastCommandWords(command);
  if (!w.length) return null;
  const head = path.basename(w[0]);
  if (LENIENT_EXIT1.has(head)) return head + ' exited 1 (no match, files differ, or a false test)';
  if (head === 'git') {
    let i = 1;
    while (w[i] && w[i].startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    if (w[i] === 'diff' || w[i] === 'grep') return 'git ' + w[i] + ' exited 1';
  }
  return null;
}

// Best-effort patterns for commands that change something. Rules marked raw look inside quoted text (SQL is always quoted).
const MUTATION_RULES = [
  [/(?:^|[\s;&|(])(?:sudo\s+)?(?:rm|rmdir|mv|cp|chmod|chown|chgrp|ln|mkdir|touch|truncate|dd|shred|tee|rsync|unzip|tar\s+-?[a-z]*[xc][a-zA-Z]*)(?=\s|$)/, 'changes files'],
  [/(?:^|[\s;&|(])(?:sed|perl)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i/, 'edits files in place'],
  [/(?:^|[^\d<>&=-])\d?>>?(?!&)\s*(?!\/dev\/(?:null|stdout|stderr)\b)[^\s&|;<>]/, 'redirects output into a file'],
  [/\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:push|commit|reset|checkout|switch|merge|rebase|clean|am|apply|cherry-pick|revert|rm|mv|add|restore|pull|fetch|clone|init|gc|prune)\b/, 'changes a git repository'],
  [/\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:stash(?!\s+(?:list|show)\b)|tag\s+(?!-l\b|--list\b|-n\b)[^-\s]|branch\s+(?:-[dDmMcCf]\b|--delete|--move|--copy|--force)|remote\s+(?:add|remove|rm|rename|set-url)|config\s+(?!--get|-l\b|--list|--show)[^-\s]|worktree\s+(?:add|remove|move|prune)|submodule\s+(?:add|update|init|deinit|sync))/, 'changes a git repository'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:publish|install|i|ci|add|remove|rm|uninstall|update|upgrade|up|link|unlink|version|run|exec|x|dlx|create|init)\b/, 'runs a package manager action'],
  [/(?:^|[\s;&|(])(?:npx|bunx|pnpx)\s/, 'runs a downloaded package'],
  [/\b(?:pip3?|uv|pipx|cargo|go|gem|brew|apt|apt-get|dnf|snap)\s+(?:install|uninstall|add|remove|publish|get|sync|upgrade|update)\b/, 'installs or publishes packages'],
  [/\bcurl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data\S*|-F|--form\S*|-T|--upload-file|-o|--output)\s)/i, 'sends a write request or saves a file'],
  [/(?:^|[\s;&|(])wget\s/, 'downloads a file'],
  [/\bgh\s+(?:pr\s+(?:create|merge|close|edit|comment|review|ready|reopen|checkout)|issue\s+(?:create|close|edit|comment|reopen|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|fork|archive|rename|clone|sync)|secret\s+(?:set|delete)|variable\s+(?:set|delete)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|label\s+(?:create|edit|delete|clone)|gist\s+(?:create|edit|delete))\b/, 'changes GitHub state'],
  [/\bgh\s+api\b[^|;&]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--method\s+(?:POST|PUT|PATCH|DELETE)\b|\s-[fF]\s|--field|--raw-field|--input)/, 'sends a GitHub API write'],
  [/\b(?:kubectl|oc)\s+(?:apply|create|delete|patch|replace|scale|set|label|annotate|drain|cordon|uncordon|exec|cp|rollout\s+(?:restart|undo|pause|resume))\b/, 'changes a cluster'],
  [/\bhelm\s+(?:install|upgrade|uninstall|rollback|delete)\b/, 'changes a cluster'],
  [/\b(?:docker|podman)\s+(?:rm|rmi|run|start|stop|kill|restart|push|pull|build|exec|create|tag|prune|system\s+prune|volume\s+(?:rm|prune|create)|network\s+(?:rm|create|prune)|compose\s+(?:up|down|rm|restart|stop|start|build|pull|push|run|exec))\b/, 'changes containers or images'],
  [/\b(?:terraform|tofu|pulumi)\s+(?:apply|destroy|import|up)\b/, 'changes infrastructure'],
  [/\b(?:systemctl|service)\s+(?:--user\s+)?(?:\S+\s+)?(?:start|stop|restart|reload|enable|disable|mask|unmask|kill)\b/, 'changes services'],
  [/\b(?:wrangler|vercel|netlify|flyctl|fly|firebase|railway|heroku)\s+(?:deploy|publish|delete|rollback|up|destroy|promote)\b/, 'deploys'],
  [/(?:^|[\s;&|(])(?:kill|pkill|killall|shutdown|reboot|crontab)\s/, 'changes running processes or the system'],
  [/\b(?:psql|mysql|sqlite3|mongosh|redis-cli)\b[\s\S]*\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|flushall)\b/i, 'may write to a database', true],
];

/** Returns why a shell command looks like it changes something, or null. Quoted text is ignored except where a rule says otherwise. */
export function mutationReason(command) {
  const raw = String(command);
  const bare = raw.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const [re, why, useRaw] of MUTATION_RULES) {
    const m = (useRaw ? raw : bare).match(re);
    if (m) return why + ' (' + m[0].trim().slice(0, 60) + ')';
  }
  return null;
}

export class ShellError extends Error {
  constructor(out, message) {
    super(message || 'command exited ' + out.exitCode + ': ' + out.command.slice(0, 200) + (out.stdout ? '\n' + out.stdout.slice(-2000) : ''));
    this.name = 'ShellError';
    this.stdout = out.stdout;
    this.stderr = out.stderr;
    this.exitCode = out.exitCode;
    this.command = out.command;
  }
}

export class DryRunGuardError extends Error {
  constructor(command, why) {
    super('dry run refused a command that ' + why + ': ' + command.slice(0, 200) +
      '\nWrap it in mutate or step if it changes something; if it only reads, chain .readonly().');
    this.name = 'DryRunGuardError';
    this.command = command;
  }
}

export function makeOutput(command, stdout, exitCode, extra = {}) {
  const out = {
    command, stdout, stderr: '', exitCode, truncated: false, whole: true, ...extra,
    text() { return this.stdout; },
    lines() { const l = this.stdout.split('\n'); if (l.length && l[l.length - 1] === '') l.pop(); return l; },
    json() { return this.dryRun && this.stdout === '' ? null : JSON.parse(this.stdout); },
  };
  Object.defineProperty(out, 'output', {
    enumerable: false,
    get() { return this.stdout + (this.exitCode ? '\n[exit ' + this.exitCode + ']' : ''); },
  });
  return out;
}

export function killActiveChildren() {
  for (const child of active) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

/** Runs one command with bash; stderr is merged into stdout in order. */
export function runShell(command, opts = {}, base = {}) {
  return new Promise((resolve, reject) => {
    const shell = process.env.RECIPES_SHELL || '/bin/bash';
    let child;
    try {
      child = spawn(shell, ['-c', 'exec 2>&1\n' + command], {
        cwd: opts.cwd || base.cwd || process.cwd(),
        env: { ...process.env, ...(base.env || {}), ...(opts.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) { reject(e); return; }
    active.add(child);
    const chunks = [];
    let size = 0;
    let truncated = false;
    const onData = (d) => { if (size + d.length <= MAX_BUFFER) { chunks.push(d); size += d.length; } else truncated = true; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const ms = opts.timeout ?? base.timeout ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
    }, ms);
    child.on('error', (e) => { clearTimeout(timer); active.delete(child); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      active.delete(child);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
      const out = makeOutput(command, stdout, exitCode, { truncated, whole: !truncated });
      if (timedOut) {
        out.error = 'timed out after ' + ms + ' ms';
        if (opts.throws === false) resolve(out);
        else reject(new ShellError(out, 'command timed out after ' + ms + ' ms: ' + command.slice(0, 200)));
        return;
      }
      if (exitCode === 0) { resolve(out); return; }
      const note = exitCode === 1 ? lenientExit1(command) : null;
      if (note) { out.note = note; resolve(out); return; }
      if (opts.throws === false) { resolve(out); return; }
      reject(new ShellError(out));
    });
  });
}

/** Lazy, chainable result of $ and mutate. Options chained right after the call apply before the command starts. */
export class ShellPromise {
  constructor(command, exec) {
    this.command = command;
    this.opts = { throws: true, readonly: false };
    this._exec = exec;
    this._promise = null;
    queueMicrotask(() => this._start());
  }
  _start() {
    if (!this._promise) {
      this._promise = Promise.resolve().then(() => this._exec(this.opts));
      this._promise.catch(() => {});
    }
    return this._promise;
  }
  nothrow() { this.opts.throws = false; return this; }
  throws(on = true) { this.opts.throws = Boolean(on); return this; }
  quiet() { return this; }
  timeout(ms) { this.opts.timeout = ms; return this; }
  cwd(dir) { this.opts.cwd = dir; return this; }
  env(vars) { this.opts.env = { ...(this.opts.env || {}), ...vars }; return this; }
  /** Declares a command read-only so a dry run lets it through even if it looks like a write. */
  readonly() { this.opts.readonly = true; return this; }
  then(onOk, onErr) { return this._start().then(onOk, onErr); }
  catch(onErr) { return this._start().catch(onErr); }
  finally(fn) { return this._start().finally(fn); }
  text() { return this.then((o) => o.text()); }
  lines() { return this.then((o) => o.lines()); }
  json() { return this.then((o) => o.json()); }
}

async function execute(kind, command, opts, base) {
  const cwd = opts.cwd ? expandPath(opts.cwd, base.cwd) : base.cwd;
  if (kind === 'mutate') {
    if (base.actions) base.actions.push(base.dryRun ? { kind: 'shell', command, cwd, skipped: true } : { kind: 'shell', command, cwd });
    if (base.dryRun) return makeOutput(command, '', 0, { dryRun: true });
  } else if (base.dryRun && !opts.readonly) {
    const why = mutationReason(command);
    if (why) throw new DryRunGuardError(command, why);
  }
  return runShell(command, { ...opts, cwd }, base);
}

/** Builds $ (reads) and mutate (changes) bound to one run's cwd, env, dry-run flag and action list. */
export function createShells(base) {
  const make = (kind) => {
    const tag = (first, ...rest) => {
      const fromString = typeof first === 'string';
      const command = fromString ? first : buildCommand(first, rest);
      const p = new ShellPromise(command, (opts) => execute(kind, command, opts, base));
      if (fromString && typeof rest[0] === 'number') p.timeout(rest[0]);
      return p;
    };
    tag.escape = quoteArg;
    return tag;
  };
  return { $: make('read'), mutate: make('mutate') };
}
