# AdagGuard: live proof, attack suite and verification

AdagGuard pays down part of a borrower's own Morpho loan from their own wallet when it crosses a trigger they chose, just enough to bring it back to their target. These three commands prove that on live Arc mainnet state before the deploy, and against the real contract after it. Run them from the repo root.

```
node packages/contracts/prove-it/guard-prove.mjs     the proof
node packages/contracts/prove-it/guard-attack.mjs    the attack suite
bash packages/contracts/verify-guard.sh              source verification (dry path until the deploy)
```

None of them signs or sends a transaction, and none reads a key.

## Which AdagGuard they run against

- **After the deploy:** the address in `deployments/adag-guard.arc-mainnet.json`, which `deploy-guard.sh --broadcast` writes (or an `"AdagGuard"` key in `deployments/arc-mainnet.json`; if both exist they must agree). Nothing is injected.
- **Before the deploy:** AdagGuard's runtime code from the local build (`out-guard/`, made by `run-guard-tests.sh`) is injected into the simulation at the address a real deploy will give it. The deploy order is AdagBills with enrol first (`deploy.sh`), then AdagGuard (`deploy-guard.sh`). So while `"AdagBillsEnrol"` is missing from `arc-mainnet.json`, AdagGuard lands at the deployer's nonce plus one; after that, at the deployer's nonce. On 26 September the deployer is at nonce 3, so AdagBills with enrol is predicted at `0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB` and AdagGuard at `0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806` (nonce 4). The scripts stop if that address already holds code while no record names AdagGuard.

`deploy-guard.sh --dry-run` predicts the address for the deployer's next transaction, so run on its own before AdagBills it shows the nonce-3 address. That is right only if AdagGuard were sent first.

## guard-prove.mjs

Everything runs in one eth_simulateV1 request on dRPC, pinned to dRPC's latest block. The demo payer `0x6e26...1fDE` holds a real USDC-market loan: 1.000004 USDC against 0.00003133 cirBTC, 37.89% on 26 September.

1. The payer sets a rule on the USDC market: act at 35%, bring the loan back to 30%, no expiry.
2. The payer approves AdagGuard for 1 USDC, the most it can ever take.
3. A stranger reads `quote`, then calls `protect`.
4. The stranger calls `protect` again at the same price.

It checks, and prints PASS or FAIL for each:
- the rule is stored as set
- quote says it would act, and by how much
- protect repaid exactly that
- the loan-to-value landed at or under 30% (also shown to every digit)
- the pull equals the repay, and Morpho's Repay event names the payer
- the payer's approval fell by exactly the repay
- AdagGuard's balance and its approval to Morpho are unchanged
- no bitcoin was sold (wallet plus pledged)
- the second protect repaid 0 and moved nothing

Run of 26 September at block 22858225: the stranger's protect repaid 0.208166 USDC, taking the loan from 37.89% to 30.00%. The second protect repaid 0. Gas: setRule 129,321, approve 55,438, protect 211,485, the repeat protect 112,339.

It stops rather than proving nothing if the payer has no loan or the loan is already under 35%.

## guard-attack.mjs

Each attack is its own simulation from the same block. It prints the attack, what should stop it, the decoded result and PASS or FAIL. It then appends the table to `deployments/attacks-<date>-guard.md`.

| # | Attack | Threat model |
|---|---|---|
| G1 | Pull above the approval (0.1 USDC approved, about 0.21 needed), twice | C36, C38 as amended |
| G2a to c | The other real USDC/cirBTC market id, a look-alike id one hex digit off, the EURC market | C35, C41 |
| G3 | protect below the trigger | C36 |
| G4 | protect at the second a rule expires | C41 |
| G5a, b | A stranger clears, or sets, a rule hoping to reach the payer's | C34 |
| G6 | protect three times at the same price | C38 as amended |
| G7 | The wallet holds less than needed | C36 |
| G8 | Simulated price crash to zero: capped at the debt rounded down, no revert | C36, C37 |
| G9a, b | A payer with an approval but no rule, even at zero price; a wallet with no loan | C36, C41 |
| G10 | Admin calls a drain would need (owner, withdraw, rescue, pause, upgrade), and the ABI's state-changing functions | C39 |

State overrides are used for two things only: giving the simulated stranger some native USDC, and, in G8 and G9, `mock/MockOracle.sol` at the market oracle's address, labelled as a simulated crash. AdagGuard and Morpho state are never overridden. G7 lowers the payer's balance with a real transfer inside the simulation, not an override.

Run of 26 September at block 22858500: 14 of 14 rows passed.

## verify-guard.sh

- **Dry path** (before the deploy, or with `--dry-run`):
  - builds AdagGuard into `out-guard`;
  - produces the Standard JSON input in a temporary folder;
  - compiles that input again with solc 0.8.30 and checks it rebuilds exactly the runtime code of the build, and of the chain once deployed;
  - prints what the real path would send.

  It sends nothing and writes nothing in the repo. On 26 September the input rebuilt all 7,981 bytes exactly.
- **Real path** (once AdagGuard is recorded):
  - writes `deployments/<deploy day>/AdagGuard.standard-json.json` with `AdagGuard.abi.json` beside it, and the proof scripts read that ABI;
  - submits to Sourcify;
  - submits to Etherscan (ArcScan) only when `ETHERSCAN_API_KEY` is in the repo `.env`;
  - prints the manual explorer.arc.io upload steps.

## What this does not cover

- A real signed transaction. Everything here is simulated until the deploy, and even then these commands only simulate.
- Liquidations racing a protect, token pauses and Circle's blocklist, and the keeper service itself.
- Other price moves than the real price and a crash to zero. The fork tests in `test/AdagGuard*.t.sol` cover random prices, allowances and balances.
