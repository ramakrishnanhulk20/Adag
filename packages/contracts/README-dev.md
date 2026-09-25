From Windows, in the repo root: `bash packages/contracts/run-tests.sh` (it re-runs itself inside WSL Ubuntu, where Arc Foundry lives).
Inside WSL, in `packages/contracts`: `bash run-tests.sh`, which runs `arc-forge test --fork-url https://rpc.mainnet.arc.io -vv`. Extra flags pass through, for example `--match-test test_memoTagsTransfer`.
Use arc-forge only: upstream forge cannot run Arc's CallFrom precompile, so Memo and Multicall3From tests fail or lie under it.
