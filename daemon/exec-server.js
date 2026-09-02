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
 *   {"id":1,"cmd":"ls -l","workdir":"/home/crack","timeoutMs":30000,"env":{...}}
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

const PORT = Number(process.env.DSHWSL_EXEC_PORT || 37778);
const BASH = process.env.DSHWSL_BASH || '/bin/bash';
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
    this.proc = spawn(BASH, ['--noprofile', '--norc', '--noediting'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.closed = false;
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

  _exec({ cmd, workdir, env, timeoutMs }) {
    const script = [
      env && Object.keys(env).length
        ? Object.entries(env)
            .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
            .map(([k, v]) => `export ${k}=${sq(v)}`)
            .join('\n')
        : '',
      workdir ? `cd ${sq(workdir)} 2>/dev/null` : '',
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

// ONE shell for the daemon's whole lifetime (NOT per-connection).
let sharedShell = null;
function getShell() {
  if (!sharedShell || sharedShell.closed) {
    if (sharedShell) { try { sharedShell.dispose(); } catch {} }
    sharedShell = new PersistentShell();
  }
  return sharedShell;
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
    getShell().runRequest(req).then((res) => {
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
      if (typeof obj.cmd !== 'string' || obj.cmd.length === 0) {
        send({ id: obj.id ?? null, done: true, exitCode: null, error: 'empty cmd' });
        continue;
      }
      queue.push({
        id: obj.id ?? null,
        cmd: obj.cmd,
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

process.on('SIGTERM', () => { if (sharedShell) sharedShell.dispose(); process.exit(0); });
process.on('SIGINT', () => { if (sharedShell) sharedShell.dispose(); process.exit(0); });