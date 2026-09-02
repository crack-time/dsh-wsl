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