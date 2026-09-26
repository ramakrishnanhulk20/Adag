# Gas: what each Adag action costs

Measured on 25 September 2026 on a fork of Arc mainnet with Arc Foundry (arc-forge 1.7.1-dev), solc 0.8.30, optimizer 200 runs. Re-measured after the loan rule began recording collateral as well as borrow shares: payments cost 413 (cash) to 2,212 (three bills) gas more than before.

Re-measured on 26 September 2026 for the next deployment, which adds enrol, at the same fork block (22,727,600). Each payment costs 2,225 gas more than on the first deployment (three bills in one batch, 2,675 more), because `pay` now reads the payer's enrol block before anything else. Writing a bill costs 72 gas more, most likely from the larger contract's function lookup. The first deployment's figures are in this file's git history.

Arc charges fees in USDC. At the network's 20 gwei floor, every 1,000,000 gas costs 0.02 USDC, so the most expensive action below costs under 2 cents.

## The table

Each figure is the whole transaction as a wallet would send it: the 21,000 base cost, the calldata and the execution, with every account and storage slot cold. Each one is a separate transaction, so nothing is cheaper because an earlier step already touched it.

| Action | Who sends it | Gas | USDC at 20 gwei |
| --- | --- | ---: | ---: |
| Write a bill, short reference (13 bytes), first bill ever in the contract | Supplier | 196,734 | 0.0039 |
| Write a bill, short reference, a later bill from a new supplier | Supplier | 179,514 | 0.0036 |
| Write a bill, 140-byte reference (the maximum), first bill ever | Supplier | 310,756 | 0.0062 |
| Cancel an open bill | Supplier | 28,497 | 0.0006 |
| Record an existing loan once (enrol), with a USDC loan already open on Morpho | Payer | 84,923 | 0.0017 |
| Pay one bill from a USDC balance: approve, then pay through Memo | Payer | 189,024 | 0.0038 |
| Pay one bill from bitcoin: approve cirBTC, pledge, borrow, approve USDC, pay through Memo | Payer | 398,272 | 0.0080 |
| Pay three bills in one signature: pledge and borrow in both markets, two USDC bills and one EURC bill | Payer | 828,382 | 0.0166 |
| Close the loan in full an hour later: approve, repay by exact shares, take all cirBTC back, reset the approval | Payer | 154,599 | 0.0031 |

Deploying the contract once costs 2,227,984 gas, about 0.045 USDC. `deploy.sh --dry-run` prints 2,896,379, which is that figure plus the 30% margin forge adds to every script estimate.

What moves the numbers:
- **Writing a bill.** The first bill ever costs 17,220 more than a later one, because it creates the bill counter. Both measured bills were their supplier's first, which also creates that supplier's bill list; a supplier's later bills skip that step and should cost less (not measured). A reference over 31 bytes is stored in its own slots: the 140-byte one used 5 more slots than the short one, 114,022 more gas.
- **Enrolling.** Enrol reads the payer's position in both markets from Morpho and writes three storage slots: one recorded position per market and the enrol block. A payer does it once, and then pays each bill at the cash price above. With loans open in both markets it writes two new positions instead of one; the gas report's highest enrol call is 104,823 gas before the 21,000 base cost (not measured as its own transaction).
- **Paying from bitcoin.** The extra 209,248 gas over a cash payment is Morpho's own pledge and borrow plus Adag's 40% check, which reads the oracle, the price feed and the market totals.
- **Three bills.** 828,382 gas is about 2.1 times one loan-backed payment, for three bills across two markets.
- **Closing a loan.** Measured inside one test, where storage was already warm, the same close used 88,403 gas. A real close is its own transaction, so expect the cold figure.

## How it was measured

```
bash packages/contracts/run-tests.sh --match-contract AdagGasScenarios --isolate -vvvv
```

`AdagGasScenarios` in `test/AdagFuzz.t.sol` has one test per action. The measured action is one top-level call, and its setup (writing the bill, taking the loan) is done in earlier top-level calls. `--isolate` runs each top-level call as its own transaction, which is what makes the figures cold and includes the base cost. The numbers above are the gas shown for the measured call in the trace.

`bash packages/contracts/run-tests.sh --gas-report` also runs, and its table for `AdagBills` shows `createBill` from 179,514 (median) to 311,129 (max) across all tests, `enrol` from 50,723 (median) to 104,823 (max), and `collateralNeeded`, `loanToValue` and `priceStatus` at up to 57,000, 78,000 and 63,000 gas. Those are views that cost nothing when called from an app, since a read is free. The report cannot measure `pay` itself: every real payment reaches Adag through Arc's Memo and CallFrom, which the report does not count, so its `pay` row only shows calls that were refused in their first lines. The batch figures in the table therefore come from the isolated traces.

## What these figures do not cover

- They are one fork block's state. When another transaction has already touched the Morpho market earlier in the same block, Morpho and Adag skip the interest step and the payment costs a little less.
- Arc's base fee can rise above the 20 gwei floor when blocks are busy. Fees scale with it.
- A wallet may add its own margin to the gas limit; only the gas actually used is charged.

## AdagGuard

Measured on 26 September 2026 with the same toolchain on a fork of Arc mainnet at block 22727600. As above, each figure is a whole cold transaction, base cost included.

| Action | Who sends it | Gas | USDC at 20 gwei |
| --- | --- | ---: | ---: |
| Set a first rule: writes the rule and adds the wallet to the list of rule holders | Borrower | 129,321 | 0.0026 |
| Clear the last rule: deletes it and takes the wallet off the list (storage refunds lower the cost) | Borrower | 37,619 | 0.0008 |
| Protect that repays: accrue Morpho interest, pull 838.08 USDC, approve Morpho, repay, check nothing stayed behind | Keeper or anyone | 180,235 | 0.0036 |
| Protect that does nothing because the loan is under the trigger, interest step included | Keeper or anyone | 109,521 | 0.0022 |

Deploying AdagGuard once is estimated at 2,312,529 gas by the dry run against live mainnet, about 0.046 USDC at the 20 gwei floor.

What moves the numbers:
- **A protect that does nothing** still pays for Morpho's interest step (about 25,000 gas including the rate model) and the reads the check needs. `quote` gives the same answer for free, so a keeper should read it first and send `protect` only when it says the guard would act. When the market was already touched earlier in the same block, protect skips the interest step and costs less.
- **The protect that repays** was measured on the USDC market, taking a loan from 75% to 59.99999999% against a 60% target.
- **Changing an existing rule** rewrites one storage slot and skips the list step, so it should cost less than a first rule (not measured).

How it was measured:

```
bash packages/contracts/run-guard-tests.sh --match-contract AdagGuardGasScenarios --isolate -vvvv
```

`AdagGuardGasScenarios` in `test/AdagGuardFuzz.t.sol` has one test per action, with its setup in earlier top-level calls. The numbers above are the gas shown for the measured AdagGuard call in the trace.
