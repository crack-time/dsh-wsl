# @crack/dsh-wsl — WSL workspaces for DSH web

A DeepSeek Harness plugin that lets you **create / register workspaces on the
WSL Linux filesystem** and have them appear in the dsh sidebar mixed with
native Windows workspaces. Commands in a WSL workspace run *inside the distro*
via a purpose-built `wsl` tool — without replacing the host's single
`ctx.shell` provider.

## Two concerns, two mechanisms

### 1. Workspace browser (host + client)

Registers a directory owned through its `\\wsl.localhost\<distro>\<path>` UNC
share as a completely ordinary workspace record in the native registry, so the
sidebar already lists it beside Windows workspaces and it is session-attached,
opened, and persisted like any other.

- Host: a small JSON API under `/plugins/@crack/dsh-wsl/api` (enumerate
  distros, walk the Linux filesystem, create a folder, register). Only the
  final registration touches `workspaceRegistry`; listing/creation shells out
  to `wsl.exe`.
- Client: a "＋ WSL 工作区" entry next to the native Add-workspace button opens
  a browser to pick a distro and a directory (starting from the distro's home),
  then registers it.

### 2. WSL shell tool (`@crack/dsh-wsl/tool`) + `standard-wsl` preset

`ctx.shell` is a single-provider seam owned by the host composition
(`SandboxPwshExecutor` on Windows): a second `shell` provider is rejected by
cordis (`service "shell" has been registered`), and an agent preset cannot
publish a root-realm provider. So a per-WSL-workspace shell cannot be *swapped*
into `ctx.shell`.

Instead `@crack/dsh-wsl/tool` is a model-facing **`wsl` tool** that is a normal
consumer of the host `ctx.subprocess` service and runs the command inside the
distro:

```text
wsl.exe [-d <distro>] --cd <linux-path> --exec bash -lc <script>
```

The `standard-wsl` agent preset (a user preset under
`~/.dsh/.agent-presets/standard-wsl/`) reproduces the full `standard` agent set
but disables the native `bash`/`pwsh` tools and mounts `@crack/dsh-wsl/tool`.
Select `standard-wsl` for a WSL workspace's session and its commands run in the
distro; Windows workspaces keep the native tools untouched.

#### Runtime: bridge vs daemon (resident execution)

The tool has two ways to run a command in the distro:

- **`runtime: bridge`** (default): spawn `wsl.exe` per call — a fresh bash each
  time, no state between calls.
- **`runtime: daemon`**: send the command to a **resident WSL exec-server**
  (`daemon/exec-server.js`) holding a single persistent bash. `cd` / `export`
  survive across calls (state persists), and each call avoids the per-command
  WSL kernel handshake.

The `daemon/` directory ships the P0 implementation:

| file | role |
|---|---|
| `daemon/exec-server.js` | resident bash execution machine (zero-dependency Node, runs on `~/.zcode/server/node` v22 inside WSL) |
| `daemon/launch.sh` | detach + revive helper; resolves Node by preference (`node` on PATH → linuxbrew `~/.linuxbrew/bin/node` → bundled `~/.zcode/server/node` fallback), `setsid nohup`, writes `daemon.pid` |
| `daemon/dshwsl-env.bash` | BASH_ENV bootstrap for the persistent bash: reproduces `~/.bashrc`'s exported env (linuxbrew, conda, cuda/lammps PATH) bypassing its non-interactive guard, so brew/node/npm/conda are callable from `wsl` commands |
| `daemon/client.cjs` | Windows-side test client (`node daemon/client.cjs`) |

The daemon listens on `127.0.0.1:37778`; Windows reaches it through WSL2's
automatic localhost forwarding (the model + UI loop stay in Windows). To use
it:

```bash
# inside WSL: start the resident exec-server once
bash ~/.dshwsl/launch.sh          # or: cd ~/.dshwsl && setsid nohup ~/.zcode/server/node exec-server.js &
```

then point the preset's `tool-wsl` row at it:

```yaml
# daemon is the preferred runtime for `@crack/dsh-wsl/tool`: when the config
# omits `runtime` (or sets 'daemon'), commands go to the resident exec-server
# and fall back to the one-shot bridge automatically if the daemon is
# unreachable. Set `runtime: 'bridge'` to force per-call wsl.exe.

- id: tool-wsl
  name: '@crack/dsh-wsl/tool'
  config:
    distro: 'Ubuntu-22.04'
    runtime: 'daemon'
    daemon: { host: '127.0.0.1', port: 37778 }
```

Background (`run_in_background`) requests still bridge via `wsl.exe`. In
`daemon` mode, a hard timeout terminates and respawns the persistent shell
(state lost only on timeout). If the daemon is not reachable, the tool
**auto-starts it** (spawning a detached `setsid nohup ... exec-server.js` via
`wsl.exe`, throttled) and retries once, then falls back to the one-shot bridge
with a note in the output only if the start/reach still fails. `launch.sh` is
then just a manual convenience, not a requirement.

## Requirements

- Windows host with **WSL** installed and at least one distro (see `wsl -l`).
- The `@crack/dsh-wsl` package linked into the web profile.

## Install

```powershell
dsh plugin --profile web add "link:E:\Desktop\work\dsh-wsl"
```

## Activate

Merge the row from `cordis.patch.yml` into the profile patch
`C:\Users\crack\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: wsl
      name: '@crack/dsh-wsl'
```

Then, for each WSL workspace you want to run Linux commands in, select the
`standard-wsl` agent preset when creating/opening its session (the preset lives
in `~/.dsh/.agent-presets/standard-wsl/`). The tool's default distro
(`Ubuntu-22.04`) can be overridden in that preset's `tool-wsl` row `config`.

## Development

```powershell
npm run build        # tsc (host+client) → lib/, then tsdown client bundle
npm run typecheck
```

The WSL tool source is `src/tool.ts`; it mirrors the stock `dsh-tool-bash`
request/spec and `@deepseek-ai/dsh-timeout` deadline vocabulary, delegating
process mechanics to `ctx.subprocess`.