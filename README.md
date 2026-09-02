# @crack/dsh-wsl — WSL remote shell executor for DSH

A host-only DeepSeek Harness plugin that replaces the Windows PowerShell shell
with a **WSL remote bash executor**. The model's `bash` tool runs inside a WSL
distro — a "remote-connection" experience — while the DSH host keeps running
natively on Windows (file tools, web UI, and persistence are untouched; the
Windows session workspace is reached from Linux through `/mnt/<drive>/...`).

## How it works

`dsh-wsl` subclasses `LocalBashExecutor` at its documented execution boundary
(`runArgv` / `startArgv`) and rewrites the argv to:

```text
wsl.exe [-d <distro>] --cd <posix workdir> -- bash [-l] -c <command>
```

- Windows workdirs are translated: `E:\x` → `/mnt/e/x`; `\\wsl.localhost\D\h\y`/`\\wsl$\D\h\y` → `/y`; POSIX and relative paths pass through.
- `wsl.exe` does **not** forward the parent environment, so the model-friendly defaults and `DSH_*` snapshot are re-exported inside the Linux shell via an `export`/`unset` prefix (the `wslCommand` helper).
- Deadlines, bounded output, spill files, and the background-process lifecycle all belong to the base class; only the argv changes.

The base class is resolved at runtime against the **running** dsh install (same
ESM module instance, no version drift, no runtime dependency to install).

## Requirements

- Windows host with **WSL** installed and at least one distro (see `wsl -l`).
- A working `@deepseek-ai/dsh-bash-local` in the dsh install (shipped with dsh).

## Install

Link the package into the web profile once:

```powershell
dsh plugin --profile web add "link:E:\Desktop\work\dsh-wsl"
```

## Activate

Merge the rows from `cordis.patch.yml` into the profile patch
`C:\Users\crack\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- id: pwsh-sandbox
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-bash
  disabled: false
- insert:
    - id: wsl
      name: '@crack/dsh-wsl'
      config:
        distro: 'Ubuntu-22.04'
```

This disables the Windows pwsh executor and the pwsh tool, enables the bash
tool, and mounts `dsh-wsl` as the single `ctx.shell` provider. Set `distro` to
your WSL distro (or omit it for the default). Editing the profile patch
hot-reloads on save — no restart. Distro can also be forced per-env with
`DSH_WSL_DISTRO`.

> The plugin is a host injector of `ctx.shell`. Only activate it on a machine
> with WSL present — otherwise the rewritten `wsl.exe` argv fails visibly on
> every command and the bash tool becomes unusable.

## Development

```powershell
npm run build        # tsc → lib/
npm run typecheck
npm run check:local  # offline pure-function tests (no WSL needed)
npm test             # full end-to-end over a real WSL distro (requires WSL)
```

`test/run.mjs` composes a fresh cordis context with the real
`dsh-subprocess-local` spawn service and `WslBashExecutor`, then asserts that
commands really land inside WSL. `test/selfcheck.mjs` verifies module loading
and the pure helpers (`toWslPath`, `wslCommand`) anywhere.