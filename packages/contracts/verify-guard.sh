#!/usr/bin/env bash
# Publishes AdagGuard's source for the explorer and Sourcify.
#   bash verify-guard.sh             the real path once AdagGuard is recorded, otherwise the dry path
#   bash verify-guard.sh --dry-run   the dry path even after the deploy
#
# Dry path: sends nothing and writes nothing in the repo. It builds AdagGuard, produces the Standard JSON input
# in a temporary folder, compiles that input again with solc and checks it gives exactly the runtime bytecode of
# the build (and, once deployed, of the code on chain), then prints what the real path would send.
# Real path: writes deployments/<deploy day>/AdagGuard.standard-json.json with AdagGuard.abi.json beside it, runs
# Sourcify (no key), runs Etherscan (ArcScan) only when ETHERSCAN_API_KEY is in the repo .env, then prints the
# manual explorer.arc.io steps, because that explorer blocks scripted submissions today (arc-node issue 425).
#
# The address comes from deployments/adag-guard.arc-mainnet.json (written by deploy-guard.sh --broadcast), or an
# "AdagGuard" key in deployments/arc-mainnet.json. Before the deploy, the dry path uses the predicted address:
# deploy.sh sends AdagBills with enrol first, so while "AdagBillsEnrol" is not in arc-mainnet.json the guard
# lands at the deployer's nonce plus one, and after it at the deployer's nonce.
# It builds into out-guard and cache-guard, never the shared out and cache.
set -euo pipefail
set +x

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/verify-guard.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
export FOUNDRY_OUT=out-guard
export FOUNDRY_CACHE_PATH=cache-guard
cd "$(dirname "$0")"

RPC_URL="https://rpc.mainnet.arc.io"
CHAIN_ID=5042
DEPLOYER="0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE"
ENV_FILE="$(cd ../.. && pwd)/.env"
GUARD_RECORD="deployments/adag-guard.arc-mainnet.json"
MAIN_RECORD="deployments/arc-mainnet.json"
TARGET="src/AdagGuard.sol:AdagGuard"
ARTIFACT="out-guard/AdagGuard.sol/AdagGuard.json"
SOLC="$HOME/.local/share/svm/0.8.30/solc-0.8.30"
ETHERSCAN_URL="https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}"

die() {
    printf 'verify-guard.sh: %s\n' "$1" >&2
    exit 1
}

mode="auto"
case "${1:-}" in
    "") mode="auto" ;;
    --dry-run) mode="dry-run" ;;
    *) printf 'usage: bash verify-guard.sh [--dry-run]\n' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || die "takes at most one argument, --dry-run."

unset ETHERSCAN_API_KEY
trap 'unset ETHERSCAN_API_KEY' EXIT

# Same reader as deploy.sh: one NAME=value line, never sourced, never printed.
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

chain="$(arc-cast chain-id --rpc-url "$RPC_URL")"
[ "$chain" = "$CHAIN_ID" ] || die "RPC reports chain id ${chain}, expected ${CHAIN_ID}."

# Prints "address solc runs evm day" for the recorded AdagGuard, or nothing when it is not deployed. The two
# records must agree when both name it.
recorded="$(python3 - "$GUARD_RECORD" "$MAIN_RECORD" "$CHAIN_ID" <<'PY'
import json, os, re, sys
found = []
for path in sys.argv[1:3]:
    if not os.path.exists(path):
        continue
    record = json.load(open(path))
    c = record.get("AdagGuard")
    if not c:
        continue
    if record.get("chainId") != int(sys.argv[3]):
        sys.exit(f"{path} is not for Arc mainnet")
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", str(c.get("address"))):
        sys.exit(f"{path} has no valid AdagGuard address")
    day = str(c.get("deployedAt", ""))[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        sys.exit(f"{path} has no valid AdagGuard deployedAt")
    found.append((c["address"], c["solc"], c["optimizerRuns"], c["evmVersion"], day))
if len(found) == 2 and found[0][0].lower() != found[1][0].lower():
    sys.exit("the two deployment records name different AdagGuard addresses")
if found:
    print(*found[0])
PY
)" || die "could not read the AdagGuard deployment record."

if [ -n "$recorded" ]; then
    read -r address solc runs evm deployed_day <<<"$recorded"
    deployed=true
else
    deployed=false
    [ "$mode" = "auto" ] && mode="dry-run"
    nonce="$(arc-cast nonce "$DEPLOYER" --rpc-url "$RPC_URL")"
    [[ "$nonce" =~ ^[0-9]+$ ]] || die "unexpected nonce from the RPC: '${nonce}'."
    enrol_recorded="$(python3 -c 'import json, os, sys; p = sys.argv[1]; print("yes" if os.path.exists(p) and "AdagBillsEnrol" in json.load(open(p)) else "no")' "$MAIN_RECORD")"
    guard_nonce=$((nonce + 1))
    [ "$enrol_recorded" = "yes" ] && guard_nonce="$nonce"
    address="$(arc-cast compute-address "$DEPLOYER" --nonce "$guard_nonce" | grep -oE '0x[0-9a-fA-F]{40}')"
    solc="0.8.30"
    runs="$(arc-forge config --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["optimizer_runs"])')"
    evm="$(arc-forge config --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["evm_version"])')"
fi
[ "$mode" = "auto" ] && mode="real"

if [ "$deployed" = true ]; then
    code="$(arc-cast code "$address" --rpc-url "$RPC_URL")"
    [ "${#code}" -gt 2 ] || die "no contract code at ${address} on Arc mainnet."
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"; unset ETHERSCAN_API_KEY' EXIT

# Tests and scripts are skipped so a half-edited file elsewhere cannot stop a verification build. Its lint
# warnings go to a log that is shown only if the build fails.
arc-forge build --skip test --skip script >"${work}/build.log" 2>&1 || { cat "${work}/build.log"; die "arc-forge build failed."; }

compiler="$(python3 - "$ARTIFACT" "$solc" "$runs" "$evm" <<'PY'
import json, sys
meta = json.load(open(sys.argv[1]))["metadata"]
version = meta["compiler"]["version"]
settings = meta["settings"]
if not version.startswith(sys.argv[2] + "+commit."):
    sys.exit(f"build used solc {version}, expected {sys.argv[2]}")
if settings["optimizer"]["runs"] != int(sys.argv[3]) or settings["evmVersion"] != sys.argv[4]:
    sys.exit("build settings differ from the deploy settings")
print("v" + version)
PY
)" || die "the local build does not match the deploy settings."

arc-forge verify-contract "$address" "$TARGET" --compiler-version "$compiler" --show-standard-json-input \
    >"${work}/AdagGuard.standard-json.json" 2>"${work}/std.log" || { cat "${work}/std.log"; die "forge could not produce the Standard JSON input."; }

# The input must rebuild exactly the runtime code of the local build, and of the chain once deployed. Only the
# output selection is widened here; it does not enter the bytecode or its metadata hash.
[ -x "$SOLC" ] || die "solc 0.8.30 not found at ${SOLC}; arc-forge build installs it."
python3 - "${work}/AdagGuard.standard-json.json" "$ARTIFACT" "$SOLC" "${code:-}" <<'PY' || die "the Standard JSON input does not rebuild AdagGuard's bytecode."
import json, subprocess, sys
std_path, artifact_path, solc, onchain = sys.argv[1:5]
std = json.load(open(std_path))
if "src/AdagGuard.sol" not in std.get("sources", {}):
    sys.exit("src/AdagGuard.sol is not in the Standard JSON input")
std["settings"]["outputSelection"] = {"src/AdagGuard.sol": {"AdagGuard": ["evm.deployedBytecode.object"]}}
res = json.loads(subprocess.run([solc, "--standard-json"], input=json.dumps(std), capture_output=True, text=True, check=True).stdout)
errors = [e for e in res.get("errors", []) if e.get("severity") == "error"]
if errors:
    sys.exit("solc refused the input: " + errors[0].get("formattedMessage", ""))
rebuilt = "0x" + res["contracts"]["src/AdagGuard.sol"]["AdagGuard"]["evm"]["deployedBytecode"]["object"]
built = json.load(open(artifact_path))["deployedBytecode"]["object"]
if rebuilt.lower() != built.lower():
    sys.exit("rebuilt runtime code differs from out-guard")
if onchain and rebuilt.lower() != onchain.lower():
    sys.exit("rebuilt runtime code differs from the code on chain")
print(f"Standard JSON input rebuilds AdagGuard exactly: {len(built) // 2 - 1} bytes of runtime code" + (", identical to the chain" if onchain else ""))
PY

if [ "$mode" = "dry-run" ]; then
    cat <<EOF

Dry run only. Nothing was sent to Sourcify, Etherscan or the explorer, no key was read, and nothing was written
in the repo (the Standard JSON input above lived in a temporary folder).
Target: ${address} ($([ "$deployed" = true ] && echo "recorded deployment" || echo "predicted: deployer ${DEPLOYER}, nonce ${guard_nonce}"))
Compiler: ${compiler}, optimizer ${runs} runs, EVM ${evm}

After the deploy, bash packages/contracts/verify-guard.sh would:
  1. write packages/contracts/deployments/<deploy day>/AdagGuard.standard-json.json and AdagGuard.abi.json
  2. submit to Sourcify: arc-forge verify-contract ${address} ${TARGET} --chain ${CHAIN_ID} --verifier sourcify
  3. submit to Etherscan (ArcScan) only if ETHERSCAN_API_KEY is in the repo .env
  4. print the manual explorer.arc.io upload steps
EOF
    exit 0
fi

[ "$deployed" = true ] || die "AdagGuard is not recorded as deployed, so there is nothing to verify yet."

day_dir="deployments/${deployed_day}"
STD_JSON="${day_dir}/AdagGuard.standard-json.json"
ABI_JSON="${day_dir}/AdagGuard.abi.json"
mkdir -p "$day_dir"
mv "${work}/AdagGuard.standard-json.json" "$STD_JSON"
python3 - "$ARTIFACT" "$ABI_JSON" <<'PY'
import json, os, sys
abi = json.load(open(sys.argv[1]))["abi"]
tmp = sys.argv[2] + ".tmp"
with open(tmp, "w", newline="\n") as f:
    json.dump(abi, f, indent=2)
    f.write("\n")
os.replace(tmp, sys.argv[2])
PY
printf 'Wrote packages/contracts/%s\nWrote packages/contracts/%s\n' "$STD_JSON" "$ABI_JSON"

failed=0

printf '\nSourcify\n'
if ! arc-forge verify-contract "$address" "$TARGET" --chain "$CHAIN_ID" --rpc-url "$RPC_URL" \
    --compiler-version "$compiler" --verifier sourcify --watch; then
    printf 'Sourcify verification failed.\n'
    failed=1
fi

printf '\nEtherscan (arc.etherscan.io)\n'
if read_env_value ETHERSCAN_API_KEY "$ENV_FILE" ETHERSCAN_API_KEY; then
    # forge reads the key from the environment, so it never appears on a command line.
    export ETHERSCAN_API_KEY
    if ! arc-forge verify-contract "$address" "$TARGET" --chain "$CHAIN_ID" --rpc-url "$RPC_URL" \
        --compiler-version "$compiler" --verifier etherscan --verifier-url "$ETHERSCAN_URL" --watch; then
        printf 'Etherscan verification failed.\n'
        failed=1
    fi
    unset ETHERSCAN_API_KEY
else
    printf 'Skipped: no Etherscan key in %s.\n' "$ENV_FILE"
fi

cat <<EOF

Manual step for explorer.arc.io (its API blocks scripts today):
  1. Open https://explorer.arc.io/contract-verification
  2. Contract address: ${address}
  3. Language Solidity, method "Standard JSON input"
  4. Compiler version: ${compiler}
  5. Upload packages/contracts/${STD_JSON}
  6. Contract name: AdagGuard (source file src/AdagGuard.sol)
  7. Constructor arguments: none, leave empty
  8. Submit, then check the Contract tab at https://explorer.arc.io/address/${address} shows the source
Sourcify match: https://repo.sourcify.dev/${CHAIN_ID}/${address}
ArcScan: https://arc.etherscan.io/address/${address}#code
EOF

exit "$failed"
