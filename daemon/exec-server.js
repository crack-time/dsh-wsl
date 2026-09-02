#!/usr/bin/env node
/**
 * @crack/dsh-wsl/daemon/exec-server — resident bash execution machine for WSL.
 *
 * P0 POC. Runs INSIDE a WSL distro as a long-lived process holding ONE
 * persistent `bash` child. `cd` / `export` survive across commands because
 * the shell never exits — that is the entire point vs. the one-shot
 * `wsl.exe ... bash -lc` bridge.
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
 * therefore carry only the command's own output. Requests run sequentially.
 *
 * Zero npm dependencies (works under the bundled ~/.zcode/server/node v22).
 * Deliberately NOT a full dsh agent composition yet — Milestone 1 proves the
 * resident-execution + persistent-state mechanics end to end.
 *
 * Limitations (P0): no pty, so interactive stdin tools behave unpredictably;
 * a hard timeout terminates and respawns bash (state lost on timeout only).
 */
'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.DSHWSL_EXEC_PORT || 37778);
const BASH = process.env.DSHWSL_BASH || '/bin/bash';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 64 * 1024;

function bail(msg) {
  process.stderr.write(`[exec-server] ${msg}\n`);
  process.exit(1);
}

/** Quotes a string for safe interpolation into a single bash `-c` style block. */
function sq(v) {
  return `'${String(v).replaceAll("'", `'\\''`)}'`;
}

class PersistentShell {
  constructor() {
    // stdio[3] is the exit-code sentinel pipe.
    this.proc = spawn(BASH, ['--noprofile', '--norc', '--noediting'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.pid = this.proc.pid;
    this.pendingExitRead = null; // {resolve}
    this.closed = false;
    this.proc.on('error', () => { this.closed = true; });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      if (this._exitWait) {
        this._exitWait.resolve({ exitCode: code, signal });
        this._exitWait = null;
      }
    });
    // fd3 line-mode reader → exit codes.
    this.proc.stdio[3].setEncoding('utf8');
    this._exitWait = null;
    this.proc.stdio[3].on('data', (d) => {
      const lines = d.split('\n');
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '').trim();
        if (line === '' || !/^-?\d+$/.test(line)) continue;
        const code = Number(line);
        const w = this._exitWait;
        this._exitWait = null;
        if (w) w.resolve({ exitCode: code, signal: null });
      }
    });
  }

  /**
   * Run one command against the persistent shell. Sequential by construction:
   * the caller must not interleave two run() calls on the same shell.
   */
  runCommand({ cmd, workdir, env, timeoutMs }) {
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
      if (this.closed) {
        resolve({ ok: false, error: 'shell closed' });
        return;
      }
      let stdout = '';
      let stderr = '';
      const onOut = (d) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += d; };
      const onErr = (d) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += d; };
      this.proc.stdout.on('data', onOut);
      this.proc.stderr.on('data', onErr);

      const finish = (exitCode, signal) => {
        this.proc.stdout.off('data', onOut);
        this.proc.stderr.off('data', onErr);
        clearTimeout(selfTimeout);
        const trimmed = (s) => (stdout.length >= MAX_OUTPUT_CHARS ? `${s}\n[output truncated]` : s);
        resolve({ ok: true, done: true, exitCode, signal, stdout: trimmed(stdout), stderr: trimmed(stderr) });
      };

      const selfTimeout = setTimeout(() => {
        // Hard timeout: kill+respawn the persistent shell (state lost).
        this.proc.kill('SIGKILL');
        resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, timeout: true });
      }, timeoutMs);

      this._exitWait = { resolve: (r) => finish(r.exitCode, r.signal) };
      this.proc.stdin.write(script + '\n');
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.proc.kill('SIGKILL');
  }
}

const server = net.createServer((socket) => {
  let buffer = '';
  let shell = null;
  let busy = false;
  const queue = [];

  socket.setEncoding('utf8');
  const send = (obj) => socket.write(JSON.stringify(obj) + '\n');

  function pump() {
    if (busy || queue.length === 0) return;
    const req = queue.shift();
    if (!shell) shell = new PersistentShell();
    busy = true;
    shell
      .runCommand(req)
      .then((res) => {
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
    if (shell) shell.dispose();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[exec-server] listening on 127.0.0.1:${PORT} (pid ${process.pid})\n`);
});

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });