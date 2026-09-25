#!/usr/bin/env bash
# Runs slither, solhint and arc-forge lint on src/ and writes one output file per tool next to this script.
# On Windows it hands itself to WSL Ubuntu, where arc-forge, slither (~/.venvs/slither) and solhint live.
# Every compile goes to a throwaway folder, never the shared out/ and cache/, so it cannot disturb a test run.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
    win_dir="$(cd "$(dirname "$0")" && pwd -W)"
    drive="$(printf '%s' "${win_dir:0:1}" | tr '[:upper:]' '[:lower:]')"
    MSYS_NO_PATHCONV=1 exec wsl.exe -d Ubuntu -- bash "/mnt/${drive}${win_dir:2}/run-analysis.sh" "$@"
fi

here="$(cd "$(dirname "$0")" && pwd)"
project="$(dirname "$here")"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
export FOUNDRY_OUT="$build/out"
export FOUNDRY_CACHE_PATH="$build/cache"

# crytic-compile shells out to `forge config --json`; this shim makes that answer come from arc-forge.
mkdir -p "$build/bin"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$HOME/.local/bin/arc-forge" > "$build/bin/forge"
chmod +x "$build/bin/forge"
export PATH="$build/bin:$HOME/.local/bin:$HOME/.local/opt/node/bin:$HOME/.npm-global/bin:$HOME/.venvs/slither/bin:$PATH"

cd "$project"

forge_version="arc-forge: $(arc-forge --version | head -1)"
slither_version="slither: $(slither --version)"
solhint_version="solhint: $(solhint --version)"
printf '%s\n' "$forge_version" "$slither_version" "$solhint_version"

# Tests and scripts are skipped so a half-edited test file elsewhere cannot break the analysis build.
# This build is also the import check: solhint's import-path-check cannot read Foundry remappings.
if ! arc-forge build --build-info --force --skip test --skip script > "$build/build.log" 2>&1; then
    cat "$build/build.log"
    echo "arc-forge build failed" >&2
    exit 1
fi

set +e
{
    echo "$slither_version"
    slither . --config-file slither.config.json --foundry-out-directory "$FOUNDRY_OUT" 2>&1
} > "$here/slither-output.txt"
slither_code=$?
{
    echo "$solhint_version"
    solhint --config .solhint.json --formatter stylish 'src/**/*.sol' 2>&1
} > "$here/solhint-output.txt"
solhint_code=$?
{
    echo "$forge_version"
    arc-forge lint src 2>&1
} > "$here/lint-output.txt"
lint_code=$?
set -e

echo "slither exit $slither_code, solhint exit $solhint_code, arc-forge lint exit $lint_code"
echo "wrote $here/slither-output.txt, solhint-output.txt, lint-output.txt"
# slither runs with fail_on none, so a non-zero code from it means it crashed rather than found something.
[ "$slither_code" -eq 0 ] && [ "$solhint_code" -eq 0 ] && [ "$lint_code" -eq 0 ]
