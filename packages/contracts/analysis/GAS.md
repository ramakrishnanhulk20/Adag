# Gas: what each Adag action costs

Measured on 25 September 2026 on a fork of Arc mainnet with Arc Foundry (arc-forge 1.7.1-dev), solc 0.8.30, optimizer 200 runs.

Arc charges fees in USDC. At the network's 20 gwei floor, every 1,000,000 gas costs 0.02 USDC, so the most expensive action below costs under 2 cents.

## The table

Each figure is the whole transaction as a wallet would send it: the 21,000 base cost, the calldata and the execution, with every account and storage slot cold. Each one is a separate transaction, so nothing is cheaper because an earlier step already touched it.

| Action | Who sends it | Gas | USDC at 20 gwei |
| --- | --- | ---: | ---: |
| Write a bill, short reference (13 bytes), first bill ever in the contract | Supplier | 196,684 | 0.0039 |
| Write a bill, short reference, a later bill from a new supplier | Supplier | 179,464 | 0.0036 |
| Write a bill, 140-byte reference (the maximum), first bill ever | Supplier | 310,706 | 0.0062 |
| Cancel an open bill | Supplier | 28,497 | 0.0006 |
| Pay one bill from a USDC balance: approve, then pay through Memo | Payer | 186,386 | 0.0037 |
| Pay one bill from bitcoin: approve cirBTC, pledge, borrow, approve USDC, pay through Memo | Payer | 395,149 | 0.0079 |
| Pay three bills in one signature: pledge and borrow in both markets, two USDC bills and one EURC bill | Payer | 823,495 | 0.0165 |
| Close the loan in full an hour later: approve, repay by exact shares, take all cirBTC back, reset the approval | Payer | 154,599 | 0.0031 |

Deploying the contract once costs about 2,004,765 gas, about 0.04 USDC.

What moves the numbers:
- **Writing a bill.** The first bill ever costs 17,220 more than a later one, because it creates the bill counter. Both measured bills were their supplier's first, which also creates that supplier's bill list; a supplier's later bills skip that step and should cost less (not measured). A reference over 31 bytes is stored in its own slots: the 140-byte one used 5 more slots than the short one, 114,022 more gas.
- **Paying from bitcoin.** The extra 208,763 gas over a cash payment is Morpho's own pledge and borrow plus Adag's 40% check, which reads the oracle, the price feed and the market totals.
- **Three bills.** 823,495 gas is about 2.1 times one loan-backed payment, for three bills across two markets.
- **Closing a loan.** Measured inside one test, where storage was already warm, the same close used 88,403 gas. A real close is its own transaction, so expect the cold figure.

## How it was measured

```
bash packages/contracts/run-tests.sh --match-contract AdagGasScenarios --isolate -vvvv
```

`AdagGasScenarios` in `test/AdagFuzz.t.sol` has one test per action. The measured action is one top-level call, and its setup (writing the bill, taking the loan) is done in earlier top-level calls. `--isolate` runs each top-level call as its own transaction, which is what makes the figures cold and includes the base cost. The numbers above are the gas shown for the measured call in the trace.

`bash packages/contracts/run-tests.sh --gas-report` also runs, and its table for `AdagBills` shows `createBill` from 162,653 (median) to 311,067 (max) across all tests, and `collateralNeeded`, `loanToValue` and `priceStatus` at up to 57,000, 78,000 and 64,000 gas. Those are views that cost nothing when called from an app, since a read is free. The report cannot measure `pay` itself: every real payment reaches Adag through Arc's Memo and CallFrom, which the report does not count, so its `pay` row only shows calls that were refused in their first lines. The batch figures in the table therefore come from the isolated traces.

## What these figures do not cover

- They are one fork block's state. When another transaction has already touched the Morpho market earlier in the same block, Morpho and Adag skip the interest step and the payment costs a little less.
- Arc's base fee can rise above the 20 gwei floor when blocks are busy. Fees scale with it.
- A wallet may add its own margin to the gas limit; only the gas actually used is charged.
