#!/usr/bin/env bash
# Runs the AdagGuard tests (unit, fork, fuzz and invariants) with Arc Foundry on a mainnet fork. On Windows this
# hands itself to WSL Ubuntu, where arc-forge lives in ~/.local/bin.
#
# It builds into out-guard and cache-guard, never the shared out and cache, so it can run while other work
# builds AdagBills. Only files named AdagGuard* are matched.
#
# The fork is pinned to block 22727600, the same block run-tests.sh uses, so results do not drift with mainnet.
# Override with FORK_BLOCK=N or --fork-block-number N, or run on the newest block with FORK_BLOCK=latest.
set -euo pipefail

DEFAULT_FORK_BLOCK=22727600
FORK_BLOCK="${FORK_BLOCK:-$DEFAULT_FORK_BLOCK}"

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    # Windows variables do not cross into WSL on their own, so the pin travels as an explicit env assignment.
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- env FORK_BLOCK="$FORK_BLOCK" bash "/mnt/${drive}${win_dir:2}/run-guard-tests.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

pin=()
scope=(--match-path 'test/**/AdagGuard*.t.sol')
explicit=false
for arg in "$@"; do
    if [ "$arg" = "--fork-block-number" ] || [[ "$arg" == --fork-block-number=* ]]; then explicit=true; fi
    # A narrower path from the caller replaces the default; it should still name AdagGuard files only.
    if [ "$arg" = "--match-path" ] || [[ "$arg" == --match-path=* ]] || [ "$arg" = "--mp" ]; then scope=(); fi
done
if [ "$explicit" = false ] && [ "$FORK_BLOCK" != "latest" ]; then
    pin=(--fork-block-number "$FORK_BLOCK")
fi

echo "Fork: https://rpc.mainnet.arc.io at $([ "$explicit" = true ] && echo "the block given on the command line" || { [ "$FORK_BLOCK" = latest ] && echo "the latest block" || echo "block $FORK_BLOCK"; })"
arc-forge test --fork-url https://rpc.mainnet.arc.io "${pin[@]}" \
    --out out-guard --cache-path cache-guard \
    "${scope[@]}" -vv "$@"
