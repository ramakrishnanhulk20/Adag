#!/usr/bin/env bash
# Publishes the AdagBills source for the address recorded under RECORD_KEY in deployments/arc-mainnet.json.
# Only the deployment built from today's src/ can be verified from it. The first deployment, under "AdagBills",
# is already verified, and its Standard JSON input, with its exact source, is kept in deployments/2026-09-25/.
# Always writes the Standard JSON input and runs Sourcify (no key). Runs Etherscan (ArcScan) only when
# ETHERSCAN_API_KEY is set in the repo .env. Then prints the manual explorer.arc.io steps, because that
# explorer blocks scripted submissions today (arc-node issue 425).
set -euo pipefail
set +x

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/verify.sh" "$@"
fi

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

RPC_URL="https://rpc.mainnet.arc.io"
CHAIN_ID=5042
ENV_FILE="$(cd ../.. && pwd)/.env"
RECORD="deployments/arc-mainnet.json"
# deploy.sh carries the same key. Change both together.
RECORD_KEY="AdagBillsEnrol"
TARGET="src/AdagBills.sol:AdagBills"
ARTIFACT="out/AdagBills.sol/AdagBills.json"
ETHERSCAN_URL="https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}"

die() {
    printf 'verify.sh: %s\n' "$1" >&2
    exit 1
}

[ "$#" -eq 0 ] || die "takes no arguments. It reads the address from packages/contracts/${RECORD}."

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

[ -f "$RECORD" ] || die "no deployment found at packages/contracts/${RECORD}. Run deploy.sh --broadcast first."

read -r address solc runs evm deployed_day < <(python3 - "$RECORD" "$CHAIN_ID" "$RECORD_KEY" <<'PY'
import json, re, sys
record = json.load(open(sys.argv[1]))
if record.get("chainId") != int(sys.argv[2]):
    sys.exit("the deployment record is not for Arc mainnet")
c = record.get(sys.argv[3])
if not c:
    sys.exit(f"the deployment record has no \"{sys.argv[3]}\" entry yet. Run deploy.sh --broadcast first.")
if not re.fullmatch(r"0x[0-9a-fA-F]{40}", str(c.get("address"))):
    sys.exit("the deployment record has no valid address")
day = str(c.get("deployedAt", ""))[:10]
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
    sys.exit("the deployment record has no valid deployedAt")
print(c["address"], c["solc"], c["optimizerRuns"], c["evmVersion"], day)
PY
) || die "could not read the \"${RECORD_KEY}\" deployment from ${RECORD}."

# Each deployment's files live in a folder named for its deploy day, like the first one's in 2026-09-25/.
STD_JSON="deployments/${deployed_day}/AdagBills.standard-json.json"
mkdir -p "deployments/${deployed_day}"

code="$(arc-cast code "$address" --rpc-url "$RPC_URL")"
[ "${#code}" -gt 2 ] || die "no contract code at ${address} on Arc mainnet."

arc-forge build >/dev/null

# The explorer wants the full compiler string with its commit hash, so take it from what solc actually wrote.
compiler="$(python3 - "$ARTIFACT" "$solc" "$runs" "$evm" <<'PY'
import json, sys
meta = json.load(open(sys.argv[1]))["metadata"]
version = meta["compiler"]["version"]
settings = meta["settings"]
if not version.startswith(sys.argv[2] + "+commit."):
    sys.exit(f"build used solc {version}, the deploy record says {sys.argv[2]}")
if settings["optimizer"]["runs"] != int(sys.argv[3]) or settings["evmVersion"] != sys.argv[4]:
    sys.exit("build settings differ from the deploy record")
print("v" + version)
PY
)" || die "the local build does not match the deployed settings. Verify with the settings in ${RECORD}."

arc-forge verify-contract "$address" "$TARGET" --compiler-version "$compiler" --show-standard-json-input \
    >"${STD_JSON}.tmp"
python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "${STD_JSON}.tmp" ||
    die "forge did not produce valid Standard JSON input."
mv "${STD_JSON}.tmp" "$STD_JSON"
printf 'Wrote packages/contracts/%s\n' "$STD_JSON"

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
  6. Contract name: AdagBills (source file src/AdagBills.sol)
  7. Constructor arguments: none, leave empty
  8. Submit, then check the Contract tab at https://explorer.arc.io/address/${address} shows the source
Sourcify match: https://repo.sourcify.dev/${CHAIN_ID}/${address}
ArcScan: https://arc.etherscan.io/address/${address}#code
EOF

exit "$failed"
