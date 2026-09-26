#!/usr/bin/env bash
# Runs the fork tests with Arc Foundry. Upstream forge cannot execute Arc's CallFrom precompile, so on Windows
# this hands itself to WSL Ubuntu, where arc-forge lives in ~/.local/bin.
#
# The fork is pinned to block 22727600, just before AdagBills was deployed. Some tests spend the demo wallets'
# real balances, which the live proof has since used, so a later block would fail their setup for that reason
# alone. Override with FORK_BLOCK=N or --fork-block-number N, or run on the newest block with FORK_BLOCK=latest.
set -euo pipefail

DEFAULT_FORK_BLOCK=22727600
FORK_BLOCK="${FORK_BLOCK:-$DEFAULT_FORK_BLOCK}"

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    # Windows variables do not cross into WSL on their own, so the pin travels as an explicit env assignment.
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- env FORK_BLOCK="$FORK_BLOCK" bash "/mnt/${drive}${win_dir:2}/run-tests.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

pin=()
explicit=false
for arg in "$@"; do
    if [ "$arg" = "--fork-block-number" ] || [[ "$arg" == --fork-block-number=* ]]; then explicit=true; fi
done
if [ "$explicit" = false ] && [ "$FORK_BLOCK" != "latest" ]; then
    pin=(--fork-block-number "$FORK_BLOCK")
fi

echo "Fork: https://rpc.mainnet.arc.io at $([ "$explicit" = true ] && echo "the block given on the command line" || { [ "$FORK_BLOCK" = latest ] && echo "the latest block" || echo "block $FORK_BLOCK"; })"
arc-forge test --fork-url https://rpc.mainnet.arc.io "${pin[@]}" -vv "$@"
