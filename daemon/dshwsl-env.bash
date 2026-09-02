# @crack/dsh-wsl resident exec-server — environment bootstrap.
#
# Sourced by the persistent bash via BASH_ENV (bash reads BASH_ENV for
# NON-interactive shells). The daemon spawns `bash --noprofile --norc`, so
# ~/.bashrc is never read directly; on top of that ~/.bashrc early-returns when
# not interactive (its `case $- in *i*) ;; *) return;; esac` guard). This file
# reproduces the user's exported environment from ~/.bashrc — bypassing the
# guard by sourcing it inside a lightweight `-i` subshell and importing only
# `export -p` output (no prompt, no aliases) — then guarantees linuxbrew and
# conda are on PATH even if .bashrc does not carry them.

if [ -r "$HOME/.bashrc" ]; then
  __dshwsl_dump="$HOME/.dshwsl/.bashrc-env.dump"
  env -i HOME="$HOME" PATH="/usr/bin:/bin" TERM=xterm \
    bash -i --norc -c '. "$HOME/.bashrc" >/dev/null 2>&1; export -p' \
    > "$__dshwsl_dump" 2>/dev/null \
  && . "$__dshwsl_dump" 2>/dev/null
  rm -f "$__dshwsl_dump"
fi

# Guaranteed fallbacks: brew/node/npm and conda, independent of .bashrc content.
case ":$PATH:" in
  *":/home/linuxbrew/.linuxbrew/bin:"*) ;;
  *) export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":/home/crack/miniconda3/bin:"*) ;;
  *) [ -d /home/crack/miniconda3/bin ] && export PATH="/home/crack/miniconda3/bin:$PATH" ;;
esac