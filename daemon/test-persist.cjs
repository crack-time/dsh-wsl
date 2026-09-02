#!/usr/bin/env node
/**
 * @crack/dsh-wsl/daemon/test-persist.cjs — cross-connection persistence +
 * timeout self-heal for the resident WSL exec-server.
 *
 * The dsh `wsl` tool opens a fresh TCP connection per call but shares the
 * daemon's single persistent bash. This proves state survives ACROSS
 * connections, and that a malformed command that wedges bash is reclaimed by
 * the per-request timeout (bash respawned, later commands still run).
 *
 * Run from Windows:  node daemon/test-persist.cjs
 */
'use strict';
const net = require('node:net');
const HOST = '127.0.0.1';
const PORT = Number(process.env.DSHWSL_EXEC_PORT || 37778);

function command(req) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let buf = '';
    const out = { stdout: '', stderr: '', done: null };
    socket.on('error', (e) => { clearTimeout(t); reject(e); });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.id !== req.id) continue;
        if (f.channel === 'stdout') out.stdout += f.text;
        else if (f.channel === 'stderr') out.stderr += f.text;
        else if (f.done) { clearTimeout(t); socket.end(); out.done = f; resolve(out); }
      }
    });
    socket.write(JSON.stringify({ id: req.id, cmd: req.cmd, workdir: req.workdir, env: req.env, timeoutMs: req.timeoutMs }) + '\n');
    const wait = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 30000;
    const t = setTimeout(() => { socket.destroy(); reject(new Error('reply timeout')); }, wait + 8000);
  });
}

function section(t) { console.log(`\n== ${t} ==`); }
function show(r) {
  if (r.done.error) console.log('  ERR: ' + r.done.error);
  else {
    if (r.stdout) console.log('  stdout: ' + r.stdout.trim());
    if (r.stderr) console.log('  stderr: ' + r.stderr.trim());
    console.log(`  exit=${r.done.exitCode}`);
  }
}

(async () => {
  section('1. cross-connection persistence');
  let r = await command({ id: 1, cmd: 'cd /tmp && export MARK=hello99', workdir: '/home/crack' });
  show(r); // new socket
  r = await command({ id: 2, cmd: 'echo "MARK=$MARK pwd=$(pwd)"' }); // NEW socket, same daemon
  show(r);
  const ok = r.stdout.includes('hello99') && r.stdout.includes('/tmp');
  console.log(ok ? '  ✔ persistent across connections' : '  ✘ NOT persistent');

  section('2. timeout self-heal (wedge bash, then recover)');
  // Unterminated heredoc: bash waits forever for EOF terminator.
  const wedged = await command({ id: 3, cmd: "cat <<'EOF'", timeoutMs: 1500 });
  console.log('  wedged command settled: ' + (wedged.done.error || `exit=${wedged.done.exitCode}`));
  r = await command({ id: 4, cmd: 'echo "still-alive after wedge"' });
  show(r);
  console.log(r.stdout.includes('still-alive') ? '  ✔ recovered after wedge' : '  ✘ did NOT recover');

  section('3. exit code + stderr separation');
  r = await command({ id: 5, cmd: 'echo out1; echo err1 >&2; exit 9' });
  show(r);
  console.log(r.stdout.includes('out1') && !r.stdout.includes('err1') && r.done.exitCode === 9
    ? '  ✔ stderr separated, exit 9 propagated'
    : '  ✘ separation/exitcode wrong');

  section('4. env passthrough (the tool sends dshEnv via the env field)');
  r = await command({ id: 6, cmd: 'echo "FOO=$FOO BAR=$BAR"', env: { FOO: 'alpha', BAR: 'beta' } });
  show(r);
  console.log(r.stdout.includes('FOO=alpha') && r.stdout.includes('BAR=beta') && !r.stdout.includes('undefined')
    ? '  ✔ env exported into the persistent bash'
    : '  ✘ env export wrong');

  section('5. large output must complete (not wedge)');
  r = await command({ id: 7, cmd: 'head -c 300000 /dev/zero | tr "\\0" x; echo DONE:$(wc -c </dev/null >/dev/null; echo ok)' });
  console.log(`  reply stdout len=${r.stdout.length}, exit=${r.done.exitCode}, error=${r.done.error || 'none'}`);
  console.log((r.done.exitCode === 0 || r.done.error === void 0) && r.stdout.length > 0
    ? '  ✔ large output settled, no hang'
    : '  ✘ large output did not settle');

})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });