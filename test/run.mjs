/**
 * Standalone end-to-end test: a fresh cordis context with the REAL
 * dsh-subprocess-local spawn service, the WslBashExecutor composed on top,
 * and commands that must land inside WSL.
 *
 *   npm test
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const DSH_VENDOR = path.join(
    process.env.APPDATA ?? '',
    'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai',
);

const url = (p) => pathToFileURL(p).href;

// Real spawn service from the running dsh install (same module the host uses).
const subprocessMod = await import(url(path.join(DSH_VENDOR, 'dsh-subprocess-local', 'lib', 'index.js')));
// The built plugin.
const wslMod = await import(url(path.join(import.meta.dirname, '..', 'lib', 'index.js')));

const ctx = new Context();
ctx.plugin(subprocessMod.default);
ctx.plugin(wslMod.default, {
    cwd: 'E:\\Desktop\\work',
    timeoutMs: 120000,
    maxTimeoutMs: 600000,
    maxOutputBytes: 64000,
    maxSpillBytes: 67108864,
    graceMs: 3000,
    distro: 'Ubuntu-22.04',
});

// Wait for service start, mirroring host composition timing.
if (typeof ctx.start === 'function') {
    await ctx.start();
} else {
    await new Promise((resolve) => setTimeout(resolve, 300));
}

/** @type {import('../lib/index.js')} */
const shell = ctx.shell;

let failures = 0;
function check(label, actual, expected) {
    const ok = typeof expected === 'string' ? actual.includes(expected) : Object.is(actual, expected);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  →  ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
    if (!ok) failures += 1;
}

// 1. Commands execute in Linux.
{
    const r = await shell.run(shell.resolve({ command: 'uname -s', workdir: 'E:\\Desktop\\work\\dsh-wsl' }));
    check('uname -s reports Linux', r.stdout.text.trim(), 'Linux');
    check('clean exit code', r.exitCode, 0);
}

// 2. Windows workdir translation: cwd lands on /mnt/e/... and sees the real files.
{
    const r = await shell.run(shell.resolve({ command: 'pwd && ls package.json tsconfig.json', workdir: 'E:\\Desktop\\work\\dsh-wsl' }));
    check('workdir translated to /mnt/e', r.stdout.text, '/mnt/e/Desktop/work/dsh-wsl');
    check('workspace files visible from WSL', r.stdout.text, 'package.json');
}

// 3. Forward slashes + drive-only translation helpers.
check('toWslPath forward slashes', wslMod.toWslPath('E:/work dir/proj'), '/mnt/e/work dir/proj');
check('toWslPath bare drive', wslMod.toWslPath('C:'), '/mnt/c');
check('toWslPath WSL UNC', wslMod.toWslPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj'), '/home/me/proj');
check('toWslPath wsl$ UNC', wslMod.toWslPath('\\\\wsl$\\Ubuntu-22.04\\opt'), '/opt');
check('toWslPath POSIX passthrough', wslMod.toWslPath('/home/me'), '/home/me');

// 4. Env re-export: model-friendly defaults + dshEnv (quotes and unicode inside).
{
    const r = await shell.run(shell.resolve({
        command: 'echo "NC=$NO_COLOR TERM=$TERM DSH=$DSH_TEST_HELLO"',
        workdir: 'E:\\Desktop\\work\\dsh-wsl',
        dshEnv: { DSH_TEST_HELLO: "it's a wörld" },
    }));
    check('env forwarded into WSL shell', r.stdout.text, "NC=1 TERM=dumb DSH=it's a wörld");
}

// 5. Non-zero exits are reported, not thrown.
{
    const r = await shell.run(shell.resolve({ command: 'echo boom >&2; exit 3', workdir: 'E:\\Desktop\\work' }));
    check('nonzero exit reported', r.exitCode, 3);
    check('stderr captured', r.stderr.text, 'boom');
}

// 6. Background process lifecycle (job handles survive the tool layer).
{
    const proc = shell.start(shell.resolve({ command: 'echo bg-ready; sleep 1', workdir: 'E:\\Desktop\\work' }));
    await proc.done;
    check('background process completes', proc.status, 'completed');
    check('background output readable', proc.readOutput().delta, 'bg-ready');
}

// 7. Distro selection fallback: a bad distro surfaces as a visible command failure.
process.env.DSH_WSL_DISTRO = 'no-such-distro';
{
    const r = await shell.run(shell.resolve({ command: 'true', workdir: 'E:\\Desktop\\work' }));
    check('bad distro fails visibly (nonzero)', r.exitCode === 0 ? 'silent-success' : 'visible-failure', 'visible-failure');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
