#!/usr/bin/env bash
# Does an EIP-7702-delegated wallet still work with Arc's one-signature batching? Runs on a throwaway arc-anvil fork
# of mainnet, so nothing touches the real chain. On Windows it hands itself to WSL Ubuntu, like run-tests.sh.
#
#   bash packages/web/scripts/fork-7702.sh
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/fork-7702.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
PORT=8547
RPC="http://127.0.0.1:$PORT"

# Fresh throwaway keys derived from fixed labels. anvil's well-known test keys are no good here: on Arc mainnet
# the first one already carries someone else's 7702 delegation.
DELEGATED_KEY=$(arc-cast keccak "adag fork 7702 delegated wallet")
PLAIN_KEY=$(arc-cast keccak "adag fork 7702 plain wallet")
RECIPIENT=0x000000000000000000000000000000000000dEaD

USDC=0x3600000000000000000000000000000000000000
MEMO=0x5294E9927c3306DcBaDb03fe70b92e01cCede505
M3F=0x522fAf9A91c41c443c66765030741e4AaCe147D0
# Any contract will do as the delegation target; Multicall3 is deployed on Arc.
TARGET=0xcA11bde05977b3631167028862bE2a173976CA11
AMOUNT=10000

arc-anvil --fork-url https://rpc.mainnet.arc.io --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do arc-cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
echo "fork chain id: $(arc-cast chain-id --rpc-url "$RPC"), block $(arc-cast block-number --rpc-url "$RPC")"
DELEGATED=$(arc-cast wallet address --private-key "$DELEGATED_KEY")
PLAIN=$(arc-cast wallet address --private-key "$PLAIN_KEY")
# Arc's gas token is USDC: the native balance and the USDC ERC-20 balance are one balance. 5 USDC each.
for who in "$DELEGATED" "$PLAIN"; do
    arc-cast rpc anvil_setBalance "$who" 0x4563918244F40000 --rpc-url "$RPC" >/dev/null
    echo "funded $who: $(arc-cast call "$USDC" "balanceOf(address)(uint256)" "$who" --rpc-url "$RPC") USDC base units"
done

memo_batch() {
    local transfer memo_id memo
    transfer=$(arc-cast calldata "transfer(address,uint256)" "$RECIPIENT" "$AMOUNT")
    memo_id=$(arc-cast to-uint256 7702)
    memo=$(arc-cast calldata "memo(address,bytes,bytes32,bytes)" "$USDC" "$transfer" "$memo_id" 0x)
    echo "[($MEMO,false,$memo)]"
}

try_batch() {
    local label=$1 key=$2 who=$3 before after status
    before=$(arc-cast call "$USDC" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url "$RPC" | awk '{print $1}')
    echo "$label: $who sends Multicall3From.aggregate3 with a Memo-wrapped transfer of $AMOUNT (0.01 USDC)"
    set +e
    out=$(arc-cast send "$M3F" "aggregate3((address,bool,bytes)[])" "$(memo_batch)" --private-key "$key" --rpc-url "$RPC" --gas-price 20gwei --json 2>&1)
    set -e
    status=$(printf '%s' "$out" | grep -o '"status":"0x[01]"' | head -1)
    after=$(arc-cast call "$USDC" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url "$RPC" | awk '{print $1}')
    echo "  result: ${status:-no receipt} ; recipient rose by $((after - before))"
    [ -z "$status" ] && echo "  error: $(printf '%s' "$out" | tail -3)"
    if [ "$status" = '"status":"0x1"' ] && [ $((after - before)) -eq "$AMOUNT" ]; then echo "  PASS"; return 0; fi
    echo "  FAIL"; return 1
}

echo
echo "code at $DELEGATED before: $(arc-cast code "$DELEGATED" --rpc-url "$RPC")"
echo "delegating $DELEGATED to $TARGET with a self-sponsored EIP-7702 authorization"
arc-cast send "$RECIPIENT" --auth "$TARGET" --private-key "$DELEGATED_KEY" --rpc-url "$RPC" --gas-price 20gwei >/dev/null
CODE=$(arc-cast code "$DELEGATED" --rpc-url "$RPC")
echo "code at $DELEGATED after: $CODE"
case "$CODE" in 0xef0100*) echo "  delegation in place";; *) echo "  delegation NOT in place"; exit 1;; esac

echo
plain_ok=0; delegated_ok=0
try_batch "control, plain wallet" "$PLAIN_KEY" "$PLAIN" && plain_ok=1 || true
try_batch "delegated wallet" "$DELEGATED_KEY" "$DELEGATED" && delegated_ok=1 || true

echo
if [ $plain_ok -eq 1 ] && [ $delegated_ok -eq 1 ]; then echo "RESULT: a 7702-delegated wallet sending its own transaction works with Multicall3From and Memo on the fork"; exit 0; fi
if [ $plain_ok -eq 1 ]; then echo "RESULT: the delegated wallet FAILED where the plain wallet passed"; exit 2; fi
echo "RESULT: inconclusive, the plain control failed too"; exit 3
