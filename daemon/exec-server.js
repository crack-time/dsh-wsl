#!/usr/bin/env node
/**
 * @crack/dsh-wsl/daemon/exec-server — resident bash execution machine for WSL.
 *
 * P0 POC. Runs INSIDE a WSL distro as a long-lived process holding ONE
 * persistent `bash` child shared across ALL connections. `cd` / `export`
 * survive across commands AND across connections because the shell never
 * exits — that is the entire point vs. the one-shot `wsl.exe ... bash -lc`
 * bridge (and the dsh `wsl` tool opens a fresh TCP connection per call).
 *
 * Transport: newline-delimited JSON over a 127.0.0.1 TCP socket. Windows
 * reaches it through WSL2's automatic localhost forwarding, so the plugin
 * connects to `127.0.0.1:<port>` without any UNC path or per-call wsl.exe.
 *
 * Protocol (client → server), one line, all fields optional except id/cmd:
 *   {"id":1,"cmd":"ls -l","session":"<key?>","initWorkdir":"/home/crack/work","workdir":"<?explicit>","timeoutMs":30000,"env":{...}}
 *
 * cwd semantics: a fresh shell (per `session`) is seeded once from
 * `initWorkdir`; afterwards it keeps its persistent cwd and only `cd`s to an
 * explicitly-present `workdir`. So `cd /tmp` in one command survives into the
 * next for the same session — that is the point of a resident shell.
 *
 * Server → client, streamed:
 *   {"id":1,"channel":"stdout","text":"..."}
 *   {"id":1,"channel":"stderr","text":"..."}
 *   {"id":1,"done":true,"exitCode":0,"signal":null}
 *
 * Framing: each request's script ends with `echo $? >&3`, where fd3 is a
 * dedicated pipe the daemon watches for the exit code. stdout/stderr pipes
 * therefore carry only the command's own output.
 *
 * Concurrency + recovery:
 * - ONE shared low-level `PersistentShell`, executed through a global promise
 *   queue so requests from concurrent connections serialize (state is not
 *   per-connection, and responses can not interleave).
 * - A hard timeout kills (SIGKILL) the wedged bash and marks it closed; the
 *   next request lazily respawns it, so a malformed command self-heals after
 *   its timeout (state lost only on a timeout).
 *
 * Zero npm dependencies (works under the bundled ~/.zcode/server/node v22).
 * Deliberately NOT a full dsh agent composition yet — Milestone 1 proves the
 * resident-execution + persistent-state mechanics end to end.
 *
 * Limitations (P0): no pty, so interactive stdin tools behave unpredictably.
 */
'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, statSync, openSync, closeSync } = require('node:fs');
const { join } = require('node:path');

const PORT = Number(process.env.DSHWSL_EXEC_PORT || 37778);
const BASH = process.env.DSHWSL_BASH || '/bin/bash';
// Optional shared secret. When set, every request must carry an equal `token`;
// requests without a matching token are refused (still-reachable others get an
// error frame). Unset (default) = no authentication (localhost-only trust, as
// before). The tool / auto-launch pass DSHWSL_TOKEN so a configured daemon and
// its clients share the same secret.
const TOKEN = process.env.DSHWSL_TOKEN || null;
// BASH_ENV bootstrap that reproduces ~/.bashrc's exported env for the
// daemon's non-interactive persistent bash (see daemon/dshwsl-env.bash).
const ENV_BASH_FILE = process.env.HOME ? join(process.env.HOME, '.dshwsl', 'dshwsl-env.bash') : null;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 64 * 1024;

/** Quotes a string for safe interpolation into a single bash brace block. */
function sq(v) {
  return `'${String(v).replaceAll("'", `'\\''`)}'`;
}

function trimSpill(s, max = MAX_OUTPUT_CHARS) {
  return s.length >= max ? `${s}\n[output truncated]` : s;
}

/**
 * One persistent bash child, shared across all connections. All requests run
 * through `runRequest`, which is serialized by a global promise chain so a
 * single stdout/stderr listener window and the single fd3 `_exitWait` slot
 * are never contended.
 */
class PersistentShell {
  constructor() {
    this._queue = Promise.resolve();
    this._spawn();
  }

  _spawn() {
    // stdio[3] is the exit-code sentinel pipe.
    // For non-interactive shells bash honors BASH_ENV: point it at an env
    // bootstrap that reproduces the user's ~/.bashrc environment (linuxbrew,
    // conda, cuda/lammps PATH) without the interactive guard. Only set when
    // the file exists so a missing bootstrap is a silent no-op.
    const childEnv = ENV_BASH_FILE && existsSync(ENV_BASH_FILE)
      ? { ...process.env, BASH_ENV: ENV_BASH_FILE }
      : undefined;
    this.proc = spawn(BASH, ['--noprofile', '--norc', '--noediting'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      ...(childEnv ? { env: childEnv } : {}),
    });
    this.closed = false;
    this._initialized = false;
    this._exitWait = null;
    this.proc.on('error', () => { this.closed = true; });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      const w = this._exitWait;
      this._exitWait = null;
      if (w) w.resolve({ exitCode: code, signal });
    });
    this.proc.stdio[3].setEncoding('utf8');
    this.proc.stdio[3].on('data', (d) => {
      for (const raw of d.split('\n')) {
        const line = raw.replace(/\r$/, '').trim();
        if (line === '' || !/^-?\d+$/.test(line)) continue;
        const w = this._exitWait;
        this._exitWait = null;
        if (w) w.resolve({ exitCode: Number(line), signal: null });
      }
    });
  }

  ensureAlive() {
    if (this.closed) {
      this._spawn();
    }
    return this;
  }

  /** Serialized, global: only one bash script writes to stdin at a time. */
  runRequest(req) {
    const task = this.ensureAlive()._exec(req);
    const run = this._queue.then(() => task);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  _exec({ cmd, workdir, initWorkdir, env, timeoutMs }) {
    // cwd semantics for a persistent shell:
    //  - First request on a fresh shell: seed cwd from initWorkdir (the
    //    workspace root) so the session starts anchored, then mark initialized.
    //  - Later requests: cd only when the caller explicitly passed a `workdir`
    //    override; otherwise keep the persistent cwd (`cd` in a prior command
    //    survives). This is what makes `cd /tmp` persist across calls.
    let cdLine;
    if (!this._initialized) {
      this._initialized = true;
      const seed = initWorkdir || workdir;
      if (seed) cdLine = `cd ${sq(seed)} 2>/dev/null`;
    } else if (workdir) {
      cdLine = `cd ${sq(workdir)} 2>/dev/null`;
    }
    const script = [
      env && Object.keys(env).length
        ? Object.entries(env)
            .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
            .map(([k, v]) => `export ${k}=${sq(v)}`)
            .join('\n')
        : '',
      cdLine,
      cmd,
      'echo $? >&3',
    ].filter(Boolean).join('\n');

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const onOut = (d) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += d; };
      const onErr = (d) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += d; };
      let settled = false;
      this.proc.stdout.on('data', onOut);
      this.proc.stderr.on('data', onErr);

      const cleanup = () => {
        this.proc.stdout.off('data', onOut);
        this.proc.stderr.off('data', onErr);
        clearTimeout(timer);
      };
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: true, done: true, exitCode, signal, stdout: trimSpill(stdout), stderr: trimSpill(stderr) });
      };
      const err = (message) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, error: message });
      };

      const timer = setTimeout(() => {
        // Hard timeout: kill + close; the next request respawns a fresh shell.
        try { this.proc.kill('SIGKILL'); } catch {}
        this.closed = true;
        err(`timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      this._exitWait = { resolve: (r) => finish(r.exitCode, r.signal) };
      this.proc.stdin.write(script + '\n');
    });
  }

  dispose() {
    this.closed = true;
    try { this.proc.kill('SIGKILL'); } catch {}
  }
}

// Per-session shells, keyed by an optional `session` string in each request.
// Absent session → the 'default' shell. Each shell keeps its own persistent
// bash, so cwd/across sessions do not bleed into each other.
const SHELLS = new Map();
const DEFAULT_SESSION = 'default';
function getShell(session) {
  const key = typeof session === 'string' && session.length ? session : DEFAULT_SESSION;
  let shell = SHELLS.get(key);
  if (!shell || shell.closed) {
    if (shell) { try { shell.dispose(); } catch {} }
    shell = new PersistentShell();
    SHELLS.set(key, shell);
  }
  return shell;
}

// ── background jobs (op: bg / bg-status / bg-read / bg-cancel) ────────────
// A background job is a DETACHED bash that keeps running after the daemon
// replies. Its stdout/stderr go to ~/.dshwsl/jobs/<id>.out and its exit code to
// <id>.code, so the tool can poll status + read output at its own pace.
const JOBS_DIR = process.env.HOME ? join(process.env.HOME, '.dshwsl', 'jobs') : join('.', 'jobs');
let jobSeq = 0;
const JOBS = new Map(); // jobId -> {proc, outFile, codeFile}

function envExportLines(env) {
  if (!env) return '';
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${sq(v)}`)
    .join('\n');
}

function startBgJob(obj) {
  try { mkdirSync(JOBS_DIR, { recursive: true }); } catch {}
  const key = typeof obj.session === 'string' && obj.session ? obj.session : DEFAULT_SESSION;
  const id = `${key}-${++jobSeq}-${Date.now().toString(36)}`;
  const outFile = join(JOBS_DIR, `${id}.out`);
  const codeFile = join(JOBS_DIR, `${id}.code`);
  const script = [
    envExportLines(obj.env),
    obj.initWorkdir ? `cd ${sq(obj.initWorkdir)} 2>/dev/null` : '',
    obj.workdir ? `cd ${sq(obj.workdir)} 2>/dev/null` : '',
    obj.cmd,
  ].filter(Boolean).join('\n');
  try {
    // Open the out file for append up front and hand its fd to `spawn`'s stdio
    // (a bare WriteStream with fd:null is rejected by spawn). stdout+stderr
    // share the same fd so both interleave into <id>.out like a merged log.
    const fd = openSync(outFile, 'a');
    const proc = spawn(BASH, ['-lc', script], {
      detached: true,
      env: { ...process.env, DSHPARENT: process.pid },
      stdio: ['ignore', fd, fd],
    });
    proc.unref();
    proc.on('exit', (code) => {
      try { writeFileSync(codeFile, String(code ?? 1), 'utf8'); } catch {}
      try { closeSync(fd); } catch {}
    });
    JOBS.set(id, { proc, outFile, codeFile });
    return id;
  } catch (e) {
    try { writeFileSync(join(JOBS_DIR, '..', 'bg-error.log'), `${new Date().toISOString()} ${(e && e.stack) || e}\n`, { flag: 'a' }); } catch {}
    return null;
  }
}

function bgStatus(jobId) {
  const j = JOBS.get(jobId);
  if (!j) return { done: true, exitCode: null, missing: true };
  const alive = j.proc.exitCode === null;
  if (!alive) {
    let code = j.proc.exitCode;
    if (code === null) { try { code = Number(readFileSync(j.codeFile, 'utf8').trim()) || null; } catch {} }
    JOBS.delete(jobId);
    return { done: true, exitCode: code ?? null };
  }
  return { done: false, exitCode: null };
}

function bgCancel(jobId) {
  const j = JOBS.get(jobId);
  if (!j) return;
  try { process.kill(-j.proc.pid, 'SIGKILL'); } catch {}
  try { process.kill(j.proc.pid, 'SIGKILL'); } catch {}
}

function bgRead(jobId) {
  const j = JOBS.get(jobId);
  if (!j) return '';
  try { return readFileSync(j.outFile, 'utf8'); } catch { return ''; }
}

const server = net.createServer((socket) => {
  let buffer = '';
  let busy = false;
  const queue = [];

  socket.setEncoding('utf8');
  const send = (obj) => socket.write(JSON.stringify(obj) + '\n');

  function pump() {
    if (busy || queue.length === 0) return;
    const req = queue.shift();
    busy = true;
    getShell(req.session).runRequest(req).then((res) => {
      if (res.ok) {
        if (res.stdout) send({ id: req.id, channel: 'stdout', text: res.stdout });
        if (res.stderr) send({ id: req.id, channel: 'stderr', text: res.stderr });
        send({ id: req.id, done: true, exitCode: res.exitCode, signal: res.signal });
      } else {
        send({ id: req.id, done: true, exitCode: null, signal: null, error: res.error });
      }
      busy = false;
      pump();
    });
  }

  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { send({ id: null, error: 'bad json' }); continue; }
      if (TOKEN && obj.token !== TOKEN) {
        send({ id: obj.id ?? null, done: true, exitCode: null, signal: null, error: 'unauthorized' });
        continue;
      }
      if (obj.op === 'bg') {
        const jobId = startBgJob(obj);
        send(jobId ? { id: obj.id ?? null, kind: 'background', jobId } : { id: obj.id ?? null, done: true, error: 'bg start failed' });
        continue;
      }
      if (obj.op === 'bg-status') {
        const s = bgStatus(typeof obj.jobId === 'string' ? obj.jobId : '');
        send({ id: obj.id ?? null, done: s.done, exitCode: s.exitCode });
        continue;
      }
      if (obj.op === 'bg-read') {
        send({ id: obj.id ?? null, channel: 'stdout', text: bgRead(typeof obj.jobId === 'string' ? obj.jobId : '') });
        continue;
      }
      if (obj.op === 'bg-cancel') {
        bgCancel(typeof obj.jobId === 'string' ? obj.jobId : '');
        send({ id: obj.id ?? null, done: true, exitCode: null });
        continue;
      }
      if (typeof obj.cmd !== 'string' || obj.cmd.length === 0) {
        send({ id: obj.id ?? null, done: true, exitCode: null, error: 'empty cmd' });
        continue;
      }
      queue.push({
        id: obj.id ?? null,
        cmd: obj.cmd,
        session: typeof obj.session === 'string' && obj.session ? obj.session : undefined,
        initWorkdir: typeof obj.initWorkdir === 'string' && obj.initWorkdir ? obj.initWorkdir : undefined,
        workdir: typeof obj.workdir === 'string' && obj.workdir ? obj.workdir : undefined,
        env: obj.env && typeof obj.env === 'object' ? obj.env : undefined,
        timeoutMs: Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0 ? obj.timeoutMs : DEFAULT_TIMEOUT_MS,
      });
      pump();
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    // NOTE: do NOT dispose the shared shell here — it is daemon-lifetime.
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[exec-server] listening on 127.0.0.1:${PORT} (pid ${process.pid})\n`);
});

process.on('SIGTERM', () => { for (const s of SHELLS.values()) s.dispose(); process.exit(0); });
process.on('SIGINT', () => { for (const s of SHELLS.values()) s.dispose(); process.exit(0); });