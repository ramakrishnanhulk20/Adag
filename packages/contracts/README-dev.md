From Windows, in the repo root: `bash packages/contracts/run-tests.sh` (it re-runs itself inside WSL Ubuntu, where Arc Foundry lives). It runs every suite for both contracts, 131 tests on a fork pinned to block 22,727,600.
Inside WSL, in `packages/contracts`: `bash run-tests.sh`, which runs `arc-forge test --fork-url https://rpc.mainnet.arc.io -vv`. Extra flags pass through, for example `--match-test test_memoTagsTransfer`.
`bash run-guard-tests.sh` runs the AdagGuard suites alone, building into `out-guard` and `cache-guard` so it never touches the shared build.
Use arc-forge only: upstream forge cannot run Arc's CallFrom precompile, so Memo and Multicall3From tests fail or lie under it.
