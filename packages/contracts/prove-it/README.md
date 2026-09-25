# prove-it

One command that proves Adag's promise on Arc mainnet: a supplier bills 1 USDC, the payer settles it from
bitcoin in one signature, and the bitcoin is pledged on Morpho, not sold.

## What it proves

The script runs the same five steps whether it is a dry run or the real thing:

1. Checks the chain is Arc mainnet (5042), reads both wallets, the BTC price and whether Adag's price check
   would pass. It stops with a plain message if the price is older than 26 hours, or the payer holds under
   0.00002 cirBTC or under 0.1 USDC.
2. If the payee holds under 0.02 USDC, the payer sends it 0.05 USDC so it can pay its own fee.
3. The payee writes a bill for 1 USDC, reference `ADAG-PROOF-0001`, due in 7 days.
4. The payer signs one Multicall3From batch where every step must succeed or none do: approve cirBTC to Morpho,
   pledge it, borrow 1 USDC, approve Adag for exactly 1 USDC, pay the bill through Memo. The pledge is what
   `AdagBills.collateralNeeded` asks for plus a 5% margin.
5. Prints a receipt and checks it: the payee's USDC rose by exactly 1.000000, `BillPaid` came from Adag and
   `Memo` came from the Memo contract with the right payer, payee, bill id and reference, the bill is marked
   Paid, and the payer's cirBTC in the wallet plus pledged is unchanged (bitcoin sold: 0). It also shows the
   loan, the loan-to-value and the gas cost of each transaction.

With `--close` it signs one more batch: approve USDC to Morpho for the live debt plus 0.1%, repay by the live
borrow shares (repaying by amount leaves dust and the withdrawal fails), withdraw all the cirBTC, and set the
approval back to 0. It then checks the position is at 0 debt, 0 shares and 0 pledged.

The script exits 0 only when every check passes.

Before it builds any Morpho step, the script proves the market params the RPC returned belong to the
cirBTC/USDC market Adag checks. The params must hash to that market's id and match its hardcoded oracle, rate
model and liquidation line, so a lying RPC cannot steer the pledge into Arc's other USDC/cirBTC market.
`node packages/contracts/prove-it/prove-it.mjs --self-test` shows the check accepting the right market and
refusing the other one.

## Commands

Run from the repo root. Install once with `npm install` inside `packages/contracts/prove-it`.

```
node packages/contracts/prove-it/prove-it.mjs
node packages/contracts/prove-it/prove-it.mjs --close
node packages/contracts/prove-it/prove-it.mjs --broadcast
node packages/contracts/prove-it/prove-it.mjs --broadcast --close
```

The first two are dry runs. Every step runs inside `eth_simulateV1` on dRPC's Arc endpoint, starting from a
real mainnet block, so the balances, the Morpho market and the price feed are all live. Nothing is signed or
sent, and no private key is read. If `packages/contracts/deployments/arc-mainnet.json` does not exist yet,
the dry run places AdagBills' compiled code from `packages/contracts/out` at a placeholder address inside the
simulation and says so in the output.

`--broadcast` is for Ram only. It refuses to run without the deployment file, checks each private key in
`.env` belongs to its address, prints the full plan with every amount, and sends nothing until you type `yes`.
Each transaction prints an `https://explorer.arc.io/tx/` link.

## What it reads from .env

- Dry run: `DEPLOYER_ADDRESS` (the payer) and `PAYEE_ADDRESS` only.
- `--broadcast`: also `DEPLOYER_PRIVATE_KEY` and `PAYEE_PRIVATE_KEY`, held in memory to sign and never
  printed, logged or written anywhere.

## What --broadcast spends

Measured in the dry run on 25 September 2026 at a base fee of 20 gwei plus a 1 gwei tip:

| Transaction | Gas | Cost |
|---|---|---|
| Fee top-up to the payee (only if it holds under 0.02 USDC) | 73,938 | 0.0016 USDC |
| Payee writes the bill | 196,756 | 0.0041 USDC |
| Payer pledges, borrows and pays in one batch | 404,837 | 0.0085 USDC |
| With `--close`: repay, withdraw, reset approval | 159,587 | 0.0034 USDC |

All in, about 0.014 USDC of gas without `--close` and 0.018 USDC with it. On top of the gas:

- 0.05 USDC moves from the payer to the payee for its fees, when the payee needs it. It stays in the
  payee's wallet.
- 1 USDC moves from the payer's loan to the payee. It is the bill.
- Without `--close`, the payer keeps an open Morpho loan of about 1 USDC against about 0.00003 cirBTC. With
  `--close`, the payer repays about 1.000001 USDC from its own balance and gets all the cirBTC back, so the script
  stops before sending anything unless the payer holds about 1.15 USDC or more (the repayment, the fee
  top-up and 0.1 USDC for gas).

## What it does not cover

- It proves one bill in USDC. The EURC market, several bills in one batch, voiding a bill and the revert
  paths are not exercised here.
- A dry run proves the flow against live state as simulated by dRPC. It is not a signed transaction: it does
  not prove fee acceptance, nonce handling or that Circle's node includes the transaction. Only `--broadcast`
  proves those.
- The gas costs are dry-run measurements at one base fee. A real run pays the fee of its own block.
- It does not check that the code at the deployed address matches the compiled AdagBills.
- It does not attack Adag. It shows the happy path works; it does not try to break the 40% cap, the price
  freshness check or the pay-once rule.
