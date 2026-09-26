#!/usr/bin/env bash
# Deploys AdagGuard to Arc mainnet.
#   bash deploy-guard.sh             same as --dry-run
#   bash deploy-guard.sh --dry-run   simulates against live mainnet as the deployer address. Never reads a key and
#                                    writes nothing under deployments/.
#   bash deploy-guard.sh --broadcast the real deploy. Reads one key from the repo .env, asks for a typed yes, then
#                                    sends and records the result in deployments/adag-guard.arc-mainnet.json.
# Upstream forge cannot run Arc's EVM rules, so on Windows this hands itself to WSL Ubuntu, where arc-forge lives.
# It builds into out-guard and cache-guard, never the shared out and cache.
set -euo pipefail
set +x

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/deploy-guard.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

RPC_URL="https://rpc.mainnet.arc.io"
CHAIN_ID=5042
DEPLOYER="0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE"
ENV_FILE="$(cd ../.. && pwd)/.env"
SCRIPT_FILE="script/DeployAdagGuard.s.sol"
BROADCAST_DIR="broadcast/DeployAdagGuard.s.sol/${CHAIN_ID}"
OUT_DIR="deployments"
OUT_FILE="${OUT_DIR}/adag-guard.arc-mainnet.json"
BUILD_FLAGS=(--out out-guard --cache-path cache-guard)
EXPLORER="https://explorer.arc.io/address"
# Arc pays gas in native USDC, which has 18 decimals, so these are USDC amounts in its smallest unit.
MIN_BALANCE_WEI=100000000000000000
FEE_FLOOR_WEI=20000000000

die() {
    printf 'deploy-guard.sh: %s\n' "$1" >&2
    exit 1
}

usage() {
    printf 'usage: bash deploy-guard.sh [--dry-run | --broadcast]\n' >&2
    exit 2
}

mode="dry-run"
case "${1:-}" in
    "" | --dry-run) mode="dry-run" ;;
    --broadcast) mode="broadcast" ;;
    *) usage ;;
esac
[ "$#" -le 1 ] || usage

# The one secret this script touches never enters the environment until the moment forge needs it.
unset DEPLOYER_PRIVATE_KEY
trap 'unset DEPLOYER_PRIVATE_KEY' EXIT

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

# Balances in 18-decimal units pass bash's 64-bit integers at about 9.2 USDC, so compare them in python.
at_least() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$1" "$2"; }

# Reads a single NAME=value line from a dotenv file into the variable named by $3, without sourcing the file
# and without printing anything. Returns 1 when the name is absent or empty.
read_env_value() {
    local name="$1" file="$2" line value
    [ -r "$file" ] || return 1
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$file" | tail -n 1)" || return 1
    value="${line#*=}"
    value="${value%$'\r'}"
    value="${value%%[[:space:]]#*}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value=${value#[\"\']}
    value=${value%[\"\']}
    [ -n "$value" ] || return 1
    printf -v "$3" '%s' "$value"
}

to_usdc() { arc-cast from-wei "$1"; }

chain="$(arc-cast chain-id --rpc-url "$RPC_URL")"
[ "$chain" = "$CHAIN_ID" ] || die "RPC reports chain id ${chain}, expected ${CHAIN_ID}. Nothing sent."

balance="$(arc-cast balance "$DEPLOYER" --rpc-url "$RPC_URL")"
nonce="$(arc-cast nonce "$DEPLOYER" --rpc-url "$RPC_URL")"
base_fee="$(arc-cast base-fee --rpc-url "$RPC_URL")"
priority_fee="$(arc-cast to-dec "$(arc-cast rpc eth_maxPriorityFeePerGas --rpc-url "$RPC_URL" | tr -d '"')")"
block_now="$(arc-cast block-number --rpc-url "$RPC_URL")"
for v in "$balance" "$nonce" "$base_fee" "$priority_fee" "$block_now"; do
    is_uint "$v" || die "unexpected answer from the RPC: '${v}'. Nothing sent."
done

max_fee=$((2 * base_fee + priority_fee))
[ "$max_fee" -ge "$FEE_FLOOR_WEI" ] || max_fee="$FEE_FLOOR_WEI"

at_least "$balance" "$MIN_BALANCE_WEI" ||
    die "deployer ${DEPLOYER} holds $(to_usdc "$balance") USDC, below the 0.1 USDC minimum. Nothing sent."

predicted="$(arc-cast compute-address "$DEPLOYER" --nonce "$nonce" | grep -oE '0x[0-9a-fA-F]{40}')"

build_json() {
    # args: file address txHash block deployer deployedAt
    python3 - "$@" <<'PY'
import json, os, subprocess, sys
path, address, tx, block, deployer, at = sys.argv[1:7]
cfg = json.loads(subprocess.run(["arc-forge", "config", "--json"], check=True, capture_output=True, text=True).stdout)
record = {
    "chainId": 5042,
    "AdagGuard": {
        "address": address,
        "txHash": tx or None,
        "block": int(block),
        "deployer": deployer,
        "solc": str(cfg.get("solc") or cfg.get("solc_version")),
        "optimizerRuns": int(cfg["optimizer_runs"]),
        "evmVersion": str(cfg["evm_version"]),
        "deployedAt": at,
    },
}
tmp = path + ".tmp"
with open(tmp, "w", newline="\n") as f:
    json.dump(record, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

# Runs the script as a pure simulation against live mainnet and prints what a real send would do.
simulate() {
    local log gas cost_base cost_max sim_address
    log="$(mktemp)"
    if ! DEPLOYER_ADDRESS_PUBLIC="$DEPLOYER" ADAG_BROADCAST=false \
        arc-forge script "$SCRIPT_FILE" --rpc-url "$RPC_URL" "${BUILD_FLAGS[@]}" >"$log" 2>&1; then
        cat "$log" >&2
        rm -f "$log"
        die "simulation failed. Nothing sent."
    fi
    gas="$(grep -oE 'Estimated total gas used for script: [0-9]+' "$log" | grep -oE '[0-9]+$' || true)"
    sim_address="$(grep -oE 'AdagGuard deployed at 0x[0-9a-fA-F]{40}' "$log" | grep -oE '0x[0-9a-fA-F]{40}' || true)"
    rm -f "$log"
    is_uint "$gas" || die "could not read the gas estimate from the simulation."
    [ -n "$sim_address" ] || die "could not read the deployed address from the simulation."
    [ "${sim_address,,}" = "${predicted,,}" ] ||
        die "simulated address ${sim_address} differs from the nonce ${nonce} address ${predicted}."
    at_least "$balance" "$((gas * max_fee))" ||
        die "deployer cannot cover ${gas} gas at the max fee. Nothing sent."

    cost_base=$((gas * base_fee))
    cost_max=$((gas * max_fee))
    printf '\n'
    printf 'Network            Arc mainnet, chain id %s, block %s\n' "$chain" "$block_now"
    printf 'Deployer           %s (nonce %s, balance %s USDC)\n' "$DEPLOYER" "$nonce" "$(to_usdc "$balance")"
    printf 'Predicted address  %s\n' "$sim_address"
    printf 'Estimated gas      %s\n' "$gas"
    printf 'Base fee           %s gwei, max fee sent %s gwei\n' "$(arc-cast from-wei "$base_fee" gwei)" \
        "$(arc-cast from-wei "$max_fee" gwei)"
    printf 'Cost at base fee   %s USDC\n' "$(to_usdc "$cost_base")"
    printf 'Cost at most       %s USDC\n' "$(to_usdc "$cost_max")"
    SIM_ADDRESS="$sim_address"
}

if [ "$mode" = "dry-run" ]; then
    simulate
    printf '\nDry run only. Nothing was sent, no key was read and nothing was written under %s/.\n' "$OUT_DIR"
    exit 0
fi

# Broadcast from here on.
mkdir -p "$OUT_DIR"
[ ! -e "$OUT_FILE" ] ||
    die "${OUT_FILE} already exists. AdagGuard is immutable, so a second deploy is a new contract. Move that file aside first if you really mean it."

read_env_value DEPLOYER_PRIVATE_KEY "$ENV_FILE" DEPLOYER_PRIVATE_KEY ||
    die "no deploy key found in ${ENV_FILE}. Add the deployer key there (see .env.example)."
[[ "$DEPLOYER_PRIVATE_KEY" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] ||
    die "the deploy key in ${ENV_FILE} is not 64 hex characters."
[[ "$DEPLOYER_PRIVATE_KEY" == 0x* ]] || DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY}"

simulate

printf '\nThis sends a real transaction on Arc mainnet and spends real USDC.\n'
printf 'Type yes to deploy AdagGuard from %s: ' "$DEPLOYER"
answer=""
if { exec 3</dev/tty; } 2>/dev/null; then
    read -r answer <&3 || true
    exec 3<&-
else
    read -r answer || true
fi
[ "$answer" = "yes" ] || die "not confirmed. Nothing sent."

export DEPLOYER_PRIVATE_KEY
DEPLOYER_ADDRESS_PUBLIC="$DEPLOYER" ADAG_BROADCAST=true \
    arc-forge script "$SCRIPT_FILE" --rpc-url "$RPC_URL" "${BUILD_FLAGS[@]}" --broadcast \
    --with-gas-price "$max_fee" --priority-gas-price "$priority_fee" ||
    die "forge script failed. Check ${BROADCAST_DIR}/run-latest.json and the explorer before retrying."
unset DEPLOYER_PRIVATE_KEY

read -r tx_hash address < <(python3 - "${BROADCAST_DIR}/run-latest.json" "$DEPLOYER" "$nonce" <<'PY'
import json, sys
path, deployer, nonce = sys.argv[1], sys.argv[2].lower(), int(sys.argv[3])
run = json.load(open(path))
creates = [t for t in run["transactions"] if t.get("transactionType") == "CREATE" and t.get("contractName") == "AdagGuard"]
if len(creates) != 1:
    sys.exit("expected exactly one AdagGuard CREATE in the broadcast file")
t = creates[0]
if t["transaction"]["from"].lower() != deployer or int(t["transaction"]["nonce"], 16) != nonce:
    sys.exit("the broadcast file is not from this run")
print(t["hash"], t["contractAddress"])
PY
) || die "could not read the broadcast file. Check the explorer for ${DEPLOYER}."

[[ "$tx_hash" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "bad transaction hash in the broadcast file."
[[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "bad contract address in the broadcast file."

status="$(arc-cast receipt "$tx_hash" status --rpc-url "$RPC_URL")"
block="$(arc-cast receipt "$tx_hash" blockNumber --rpc-url "$RPC_URL")"
[[ "$status" == 1* || "$status" == "0x1" || "$status" == "true" ]] || die "transaction ${tx_hash} did not succeed (status ${status})."
is_uint "$block" || block="$(arc-cast to-dec "$block")"
code="$(arc-cast code "$address" --rpc-url "$RPC_URL")"
[ "${#code}" -gt 2 ] || die "no code at ${address} after the receipt."
block_time="$(arc-cast block "$block" --field timestamp --rpc-url "$RPC_URL")"
is_uint "$block_time" || die "unexpected block timestamp '${block_time}'."
deployed_at="$(date -u -d "@${block_time}" +%Y-%m-%dT%H:%M:%SZ)"

build_json "$OUT_FILE" "$address" "$tx_hash" "$block" "$DEPLOYER" "$deployed_at"

printf '\nAdagGuard is live at %s (block %s, tx %s)\n' "$address" "$block" "$tx_hash"
printf 'Wrote %s\n' "$OUT_FILE"
printf 'Explorer: %s/%s\n' "$EXPLORER" "$address"
printf 'Next: verify AdagGuard on the explorer. verify.sh covers AdagBills only.\n'
