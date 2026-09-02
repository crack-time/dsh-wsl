#!/usr/bin/env node
/**
 * @crack/dsh-wsl/daemon/client.js — Windows-side test client for the resident
 * WSL exec-server. NOT part of the plugin; used to prove Milestone 1 end to end
 * from Windows over WSL2's localhost forwarding.
 *
 * Usage (from Windows):
 *   node daemon/client.js            # runs a scripted persistence demo
 *   node daemon/client.js "pwd"      # single shot
 *   node daemon/client.js --interactive
 */
'use strict';
const net = require('node:net');

const HOST = process.env.DSHWSL_EXEC_HOST || '127.0.0.1';
const PORT = Number(process.env.DSHWSL_EXEC_PORT || 37778);
// Optional shared secret; set when the daemon runs with a token.
const TOKEN = process.env.DSHWSL_TOKEN;

function sendCommand(socket, req) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const out = { stdout: '', stderr: '', done: null };
    const onData = (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.id !== req.id) continue;
        if (obj.channel === 'stdout') out.stdout += obj.text;
        else if (obj.channel === 'stderr') out.stderr += obj.text;
        else if (obj.done) {
          out.done = obj;
          socket.off('data', onData);
          resolve(out);
        }
      }
    };
    socket.on('data', onData);
    socket.write(JSON.stringify({ id: req.id, cmd: req.cmd, workdir: req.workdir, env: req.env, token: req.token ?? TOKEN }) + '\n');
    const wait = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? req.timeoutMs : 30000;
    setTimeout(() => { socket.off('data', onData); reject(new Error('timeout waiting reply')); }, wait + 5000).unref();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const interactive = args[0] === '--interactive';
  const socket = net.connect({ host: HOST, port: PORT });
  await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
  console.log(`[client] connected to ${HOST}:${PORT}`);

  let seq = 0;

  if (interactive) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Interactive. Type a bash command (enter to run); empty line quits.');
    const loop = () => {
      rl.question('wsl$ ', async (line) => {
        if (!line.trim()) { rl.close(); socket.end(); return; }
        seq++;
        try {
          const r = await sendCommand(socket, { id: seq, cmd: line });
          if (r.done.error) console.log('ERR: ' + r.done.error);
          else {
            if (r.stdout) process.stdout.write(r.stdout + (r.stdout.endsWith('\n') ? '' : '\n'));
            if (r.stderr) process.stderr.write('[stderr]\n' + r.stderr);
            console.log(`[exit: ${r.done.exitCode}]`);
          }
        } catch (e) { console.log('ERR ' + e.message); }
        loop();
      });
    };
    loop();
    return;
  }

  if (args.length > 0 && args[0] !== '--interactive') {
    const r = await sendCommand(socket, { id: ++seq, cmd: args.join(' ') });
    if (r.done.error) console.log('ERR: ' + r.done.error);
    else {
      if (r.stdout) process.stdout.write(r.stdout + (r.stdout.endsWith('\n') ? '' : '\n'));
      if (r.stderr) process.stderr.write('[stderr]\n' + r.stderr);
      console.log(`[exit: ${r.done.exitCode}]`);
    }
    socket.end();
    return;
  }

  // Persistence demo: cd once, then pwd in a later command must show the cd.
  console.log('== persistence demo ==');
  seq++;
  const r1 = await sendCommand(socket, { id: seq, cmd: 'cd /home/crack && export MARKER=hello42 && pwd' });
  console.log(`cmd1 (cd+export): exit=${r1.done.exitCode}\n`, r1.stdout || '(no out)');

  seq++;
  const r2 = await sendCommand(socket, { id: seq, cmd: 'pwd && echo "MARKER=$MARKER"' });
  console.log(`cmd2 (pwd+$MARKER): exit=${r2.done.exitCode}\n`, r2.stdout || '(no out)');

  seq++;
  const r3 = await sendCommand(socket, { id: seq, cmd: 'echo bad; exit 7' });
  console.log(`cmd3 (exit 7): exit=${r3.done.exitCode}`);

  socket.end();
}

main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });