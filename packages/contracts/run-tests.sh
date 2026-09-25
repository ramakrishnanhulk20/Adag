#!/usr/bin/env bash
# Runs the fork tests with Arc Foundry. Upstream forge cannot execute Arc's CallFrom precompile, so on Windows
# this hands itself to WSL Ubuntu, where arc-forge lives in ~/.local/bin.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/run-tests.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
arc-forge test --fork-url https://rpc.mainnet.arc.io ${FORK_BLOCK:+--fork-block-number "$FORK_BLOCK"} -vv "$@"
