#!/usr/bin/env bash
# Installs the contract dependencies at the exact tags the tests were written against.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/install-deps.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
arc-forge install --no-git foundry-rs/forge-std@v1.16.2 OpenZeppelin/openzeppelin-contracts@v5.6.1
