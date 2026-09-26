#!/usr/bin/env bash
# The fork side of scripts/e2e.mjs: an arc-anvil fork of Arc mainnet with the demo payer and payee impersonated,
# and bills written by the payee with arc-cast. Nothing here touches the real chain.
#
#   bash scripts/e2e-fork.sh start
#   bash scripts/e2e-fork.sh bill USDC 400000 E2E-A      prints the new bill id
#   bash scripts/e2e-fork.sh stop
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    # wsl.exe hands its arguments to a shell again, so each is escaped once here; "approve(address,uint256)" survives.
    # shellcheck disable=SC2046
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/e2e-fork.sh" $(printf '%q ' "$@")
fi

export PATH="$HOME/.local/bin:$PATH"
RPC=http://127.0.0.1:8545
PID_FILE=/tmp/adag-e2e-anvil.pid
LOG_FILE=/tmp/adag-e2e-anvil.log

PAYER=0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE
PAYEE=0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B
ADAG=0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E
USDC=0x3600000000000000000000000000000000000000
EURC=0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1

stop() {
    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    pkill -f "arc-anvil --fork-url https://rpc.mainnet.arc.io --port 8545" 2>/dev/null || true
}

case "${1:-}" in
start)
    stop
    nohup arc-anvil --fork-url https://rpc.mainnet.arc.io --port 8545 --host 0.0.0.0 >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 90); do
        arc-cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
        sleep 1
    done
    arc-cast rpc anvil_impersonateAccount "$PAYER" --rpc-url "$RPC" >/dev/null
    arc-cast rpc anvil_impersonateAccount "$PAYEE" --rpc-url "$RPC" >/dev/null
    echo "fork up: chain $(arc-cast chain-id --rpc-url "$RPC"), block $(arc-cast block-number --rpc-url "$RPC")"
    ;;
bill)
    currency_name=${2:?currency}
    amount=${3:?amount in base units}
    ref=${4:?reference}
    case "$currency_name" in USDC) currency=$USDC ;; EURC) currency=$EURC ;; *) echo "USDC or EURC" >&2; exit 1 ;; esac
    now=$(arc-cast block latest --field timestamp --rpc-url "$RPC")
    due=$((now + 7 * 86400))
    # "hex:0x..." passes the reference bytes as they are. Text with quotes or brackets does not survive the trip from
    # Windows through Git Bash and wsl.exe intact, so a test that needs exact bytes sends them as hex.
    case "$ref" in
        hex:*) refbytes=${ref#hex:} ;;
        *) refbytes=$(arc-cast from-utf8 "$ref") ;;
    esac
    arc-cast send "$ADAG" "createBill(address,uint256,uint64,bytes)" "$currency" "$amount" "$due" "$refbytes" \
        --unlocked --from "$PAYEE" --rpc-url "$RPC" --gas-price 20gwei >/dev/null
    arc-cast call "$ADAG" "billCount()(uint256)" --rpc-url "$RPC" | awk '{print $1}'
    ;;
send)
    # A transaction from any impersonated address: send <from> <to> <signature> [args...]
    from=${2:?from}
    to=${3:?to}
    sig=${4:?signature}
    shift 4
    arc-cast rpc anvil_impersonateAccount "$from" --rpc-url "$RPC" >/dev/null
    arc-cast send "$to" "$sig" "$@" --unlocked --from "$from" --rpc-url "$RPC" --gas-price 20gwei --json | grep -o '"status":"0x[01]"' | head -1
    ;;
fund-eurc)
    # Morpho holds the EURC market's cash, so it is the one EURC holder sure to exist. Its native balance is its USDC
    # on Arc, so it already pays its own gas and must never be overwritten with anvil_setBalance.
    to=${2:?recipient}
    amount=${3:?base units}
    MORPHO=0x34CD04070dD72b14E241112F6d83812Df5Af7fCD
    arc-cast rpc anvil_impersonateAccount "$MORPHO" --rpc-url "$RPC" >/dev/null
    arc-cast send "$EURC" "transfer(address,uint256)" "$to" "$amount" --unlocked --from "$MORPHO" --rpc-url "$RPC" --gas-price 20gwei >/dev/null
    arc-cast call "$EURC" "balanceOf(address)(uint256)" "$to" --rpc-url "$RPC" | awk '{print $1}'
    ;;
stop)
    stop
    echo "fork stopped"
    ;;
*)
    echo "usage: e2e-fork.sh start | bill USDC|EURC <base units> <reference> | send <from> <to> <sig> [args] | fund-eurc <to> <base units> | stop" >&2
    exit 1
    ;;
esac
