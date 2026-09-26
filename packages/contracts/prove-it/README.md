# prove-it

One command that proves Adag's promise on Arc mainnet: a supplier bills 1 USDC, the payer settles it from
bitcoin in one signature, and the bitcoin is pledged on Morpho, not sold.

AdagGuard, the contract that pays a loan back down to the borrower's target, has its own proof, attack suite and
verification script. See [AdagGuard](#adagguard) at the end.

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

Run from the repo root. Install once with `npm ci` inside `packages/contracts/prove-it`. No build and no `.env`
are needed: without a local arc-forge build in `packages/contracts/out`, the scripts read each deployment's ABI
from the folder named for its deploy day, `deployments/2026-09-26/` for the current contract and
`deployments/2026-09-25/` for the first.

```
node packages/contracts/prove-it/prove-it.mjs
node packages/contracts/prove-it/prove-it.mjs --close
node packages/contracts/prove-it/prove-it.mjs --broadcast
node packages/contracts/prove-it/prove-it.mjs --broadcast --close
node packages/contracts/prove-it/prove-it.mjs --target first
```

## Which AdagBills: --target

With no flag, every command above runs against AdagBills with enrol, the contract Adag writes new bills on:
key `AdagBillsEnrol` in `deployments/arc-mainnet.json`, at `0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB`. That is
`--target current`, and `--target enrol` is another name for it, so the commands in the dated records under
`deployments/` still run. `--target first` picks the first deployment instead, key `AdagBills`, at
`0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E`, which stays live for the bills written on it. `attack.mjs` takes the
same flag.

- If `AdagBillsEnrol` is missing from `arc-mainnet.json`, as it was before that deploy, a dry run places the local
  build from `packages/contracts/out` (it must include `enrol`) at the address the deploy dry run predicted, key
  `AdagBillsEnrol` in `deployments/arc-mainnet.dry-run.json`, and says so. It stops if that address already holds
  code on chain, because that means the prediction is out of date: run `bash packages/contracts/deploy.sh` again.
- With the key recorded, as it is now, the commands run against the real address with no injected code.
- `--broadcast` refuses to run for a target that is not recorded.

On the current contract, prove-it runs the pay-from-bitcoin proof above, then an enrol proof:

1. It picks a real Arc borrower above 40% in the USDC market. The script carries a written list of twelve, found
   on 26 September 2026 by reading Morpho's Borrow events for that market over the public RPC and then each
   wallet's live position; they sat between 46% and 70%, with those near 60% first. At the pinned block it
   re-reads each in turn and uses the first that is above 40%, is a plain wallet (Multicall3From only runs a
   batch its sender signs itself), has a loan Adag has not already recorded as it stands, and holds the 0.1 USDC
   bill. It prints the ones it skipped and why.
2. If some qualify on everything but the balance, it uses the first of them and adds exactly 0.1 USDC to that
   wallet inside the simulation through a state override, printed as a SIMULATED TOP-UP line. Nothing real moves.
   It stops only when no listed borrower qualifies on the rest, and says which to replace.
3. Block N: the payee writes a 0.1 USDC bill; the borrower's cash payment is refused with `LtvAboveLimit`; the
   borrower calls `enrol`.
4. Block N+1: borrowing 1 USDC more in the paying batch is refused with `LtvAboveLimit`; the same bill paid from
   cash goes through.
5. Checks: `Enrolled` and `seenPosition` hold exactly Morpho's position in both markets and `enrolledAt` is block N,
   `BillPaid` says `loanChecked` false, the payee received exactly 0.1 USDC, and the bill is Paid by the borrower.

The enrol proof is always an eth_simulateV1 run, even with `--broadcast`, because it acts as that borrower's wallet
and only the borrower can sign for it. Apart from the top-up in step 2, no state is overridden for it.

The first two and the last are dry runs. Every step runs inside `eth_simulateV1` on dRPC's Arc endpoint, starting from a
real mainnet block, so the balances, the Morpho market and the price feed are all live. Nothing is signed or
sent, and no private key is read. If `packages/contracts/deployments/arc-mainnet.json` does not exist yet,
the dry run places AdagBills' compiled code from `packages/contracts/out` at a placeholder address inside the
simulation and says so in the output.

`--broadcast` is for the owner of the demo wallets only: it sends real transactions and spends their USDC. It refuses to run without the deployment file, checks each private key in
`.env` belongs to its address, prints the full plan with every amount, and sends nothing until you type `yes`.
Each transaction prints an `https://explorer.arc.io/tx/` link.

## What it reads from .env

- Dry run and the attack suite: `DEPLOYER_ADDRESS` (the payer) and `PAYEE_ADDRESS`, both optional. Without them, both scripts use the public demo wallets from the first live run, payer `0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE` and payee `0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B`, and say so. No key is read.
- `--broadcast`: `DEPLOYER_ADDRESS`, `PAYEE_ADDRESS`, `DEPLOYER_PRIVATE_KEY` and `PAYEE_PRIVATE_KEY`, all required. Without a
  `.env`, it stops before any network call. The keys are held in memory to sign and never printed, logged or written anywhere.

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

## Try to break it

```
node packages/contracts/prove-it/attack.mjs
node packages/contracts/prove-it/attack.mjs --target first
```

This runs every attack from the threat model against the live AdagBills and the demo wallet's real Morpho
loan, each in its own eth_simulateV1 run from dRPC's latest block. Nothing is signed or sent, and it reads
only the two public addresses from `.env`. The attacks: paying a paid bill again, repaying and re-borrowing the
same share count against less cirBTC, new debt past 40%, self-payment, fake currencies, zero amounts, long
references, voids by a stranger or of a paid bill, and paying without an allowance. It also shows the one
named gap: debt taken after the Adag step in the same batch gets through once, and the next payment is then
refused. A simulated 25% price drop shows a cash payment still goes through while any new debt is refused.
Last, it runs prove-it with a stubbed RPC that reports the wrong chain and shows prove-it stops. It prints a
table of each attack, what should stop it and the decoded revert, appends the same table to
`packages/contracts/deployments/attacks-<date>.md`, and exits 0 only if every row passes.

On the current contract, the default, it runs A1 to A10 and then five more rows for threat model C31 and C32.
With `--target first` it runs A1 to A10 alone against the first deployment.

- E1: enrol and pay in one batch is refused with `EnrolledThisBlock`.
- E2: borrow to about 60%, enrol and pay in one batch is refused with `EnrolledThisBlock`, and the recorded
  position is unchanged.
- E3: a stranger's enrol leaves the demo wallet's recorded position and enrol block unchanged, and the demo wallet
  can still pay in that block.
- E4: after enrolling, closing the loan outside Adag and re-borrowing the same shares against less collateral is
  refused with `LtvAboveLimit`.
- E5: the named residual, labelled "allowed by design": borrow to about 60% outside Adag and enrol in block N, and
  a cash payment in block N+1 goes through unchecked.

A1 to A4, A7 and A9 assume the demo wallet has paid a bill on the target contract and that the contract's record
of its loan matches the live loan. A fresh contract has neither, and the record falls behind whenever the loan
moves outside that contract, for example when AdagGuard repays part of it. So when the target does not show both,
every simulation starts with one setup block: the payee writes a 0.1 USDC bill and the demo wallet pays it from
cash, which runs the 40% check on its real loan and records it. The output says when this happens, and A1 and A7b
then use that bill's id. The setup needs the demo loan to be at or under 40%.

The only state overrides are native USDC for a simulated stranger, fresh bills written by the payee in an
earlier simulated block, and the mock oracle for the labelled price drop (`mock/MockOracle.sol`, compiled runtime code in
`mock/MockOracle.json`). Adag and Morpho state are never changed. Before the enrol deploy, the local build placed
at the predicted address is the one other override, and the setup block is an ordinary simulated transaction.

## What it does not cover

- It proves one bill in USDC. The EURC market, several bills in one batch, voiding a bill and the revert
  paths are not exercised here.
- A dry run proves the flow against live state as simulated by dRPC. It is not a signed transaction: it does
  not prove fee acceptance, nonce handling or that Circle's node includes the transaction. Only `--broadcast`
  proves those.
- The gas costs are dry-run measurements at one base fee. A real run pays the fee of its own block.
- It does not check that the code at the deployed address matches the compiled AdagBills.
- Before a deploy, a target proves the local build, not a deployed contract. The simulation places that code at
  the predicted address with empty storage, which is what a fresh deploy starts with.
- The enrol proof uses one borrower in the USDC market. Enrolling a Safe or any contract wallet, and the EURC
  market, are not exercised. Its borrower list is a snapshot: once none of the twelve is above 40%, it stops
  and asks for a new one.
- The proof itself does not attack Adag. It shows the happy path works; `attack.mjs` above is what tries to break the
  40% cap, the price freshness check and the pay-once rule.

## AdagGuard

AdagGuard pays down part of a borrower's own Morpho loan from their own wallet when it crosses a trigger they chose,
just enough to bring it back to their target. It is live at `0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806`, deployed on
26 September 2026 at block 22859780, and its source is an exact match on Sourcify and explorer.arc.io. Three commands,
run from the repo root:

```
node packages/contracts/prove-it/guard-prove.mjs     the proof
node packages/contracts/prove-it/guard-attack.mjs    the attack suite
bash packages/contracts/verify-guard.sh              source verification
```

As shown here none of them signs or sends a transaction, and none reads a key. Only `guard-prove.mjs --broadcast`
and `--clear`, described below, send real transactions. The two scripts read AdagGuard's address from
`deployments/adag-guard.arc-mainnet.json`, which `deploy-guard.sh --broadcast` wrote, or from an `"AdagGuard"` key
in `deployments/arc-mainnet.json` (if both exist they must agree). They stop if there is no contract at that
address. They read its ABI from `deployments/2026-09-26/AdagGuard.abi.json`, which `verify-guard.sh` wrote beside
the Standard JSON input. Nothing is injected; they run against the deployed code.

Before the deploy the same scripts ran against the local build (`out-guard/`), placed inside the simulation at
the address the deploy was going to give it. AdagBills with enrol went first at the deployer's nonce 3, so
AdagGuard was predicted at nonce 4, which is where it landed. That path still runs if the record files are
missing, and it refuses to run if the predicted address already holds code.

### guard-prove.mjs

Everything runs in one eth_simulateV1 request on dRPC, pinned to dRPC's latest block. The demo payer
`0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE` holds a real USDC-market loan: 1.000004 USDC against 0.00003133 cirBTC,
37.89%, on 26 September.

1. The payer sets a rule on the USDC market: act at 35%, bring the loan back to 30%, no expiry.
2. The payer approves AdagGuard for 1 USDC, the most it can ever take.
3. A stranger reads `quote`, then calls `protect`.
4. The stranger calls `protect` again at the same price.

It checks, and prints PASS or FAIL for each:
- the rule is stored as set
- quote says it would act, and by how much
- protect repaid exactly that
- the loan-to-value landed at or under 30%, shown to every digit
- the USDC pulled equals the repay, and Morpho's Repay event names the payer
- the payer's approval fell by exactly the repay
- AdagGuard's balance and its approval to Morpho are unchanged
- no bitcoin was sold (wallet plus pledged)
- the second protect repaid 0 and moved nothing

Run against the live contract at block 22863666: the stranger's protect repaid 0.208166 USDC, taking the loan
from 37.89% to 29.9999659%. The second protect repaid 0. Gas: setRule 129,321, approve 55,438, protect 211,485,
the repeat protect 112,339. The script stops, rather than proving nothing, if the payer has no loan or the loan
is already under 35%.

#### The real run: --broadcast

```
node packages/contracts/prove-it/guard-prove.mjs --broadcast
node packages/contracts/prove-it/guard-prove.mjs --clear
```

`--broadcast` does the same four steps with real transactions on Arc mainnet, for the owner of the demo wallets
only. The payer is `DEPLOYER_ADDRESS` and the stranger is `PAYEE_ADDRESS`, a second wallet with no link to the
payer's loan. Both are read from the repo `.env`.

1. The payer signs one Multicall3From batch, all or nothing: `setRule` (35% / 30%, no expiry) and an approval of
   exactly 1 USDC to AdagGuard.
2. The stranger sends `protect(payer, USDC market)`.
3. The stranger sends `protect` again at the same price.

What it moves:
- About 0.21 USDC of the payer's own USDC repays part of the payer's own Morpho loan, taking it from about 38% to
  30%. It never leaves for anyone else: Morpho records it against the payer's debt. The exact amount is printed
  in the plan.
- Gas from both wallets: about 505,000 gas in all, about 0.011 USDC at the current 20 gwei base fee plus a 1 gwei
  tip. The payer pays for the batch and the stranger pays for the two protects.
- No bitcoin moves. The rule and the unused approval, about 0.79 USDC, stay in place until `--clear`.

Safety, the same as prove-it.mjs:
- It checks chain id 5042 first.
- It checks that AdagGuard is the recorded deployment with code on chain.
- It proves the USDC market params by hashing them to the fixed market id.
- It refuses to send anything if the payer already has a rule in the USDC market, so a second run cannot stack
  another approval, or if the loan is under 35% at the latest block.
- It rehearses the whole plan on dRPC as these two wallets, then prints the plan with the amount it will repay and
  the gas.
- It sends nothing until `yes` is typed at the terminal, read from `/dev/tty`, or from stdin where there is no
  terminal. Closed input counts as no.
- The private keys (`DEPLOYER_PRIVATE_KEY`, `PAYEE_PRIVATE_KEY`) are read only after that `yes`, only by name, and
  checked against their addresses. They are never printed.
- It checks the two refusals again at the latest block, because minutes may pass at the prompt.
- Each transaction is estimated first, and its receipt must succeed, from the expected wallet to the expected
  fixed address.
- The targets are Multicall3From (inner calls to AdagGuard and USDC only) and AdagGuard. Fees are never under
  20 gwei.

It then makes the dry run's checks against the real receipts, plus two more: every transaction succeeded, and
the approval was exactly 1 USDC. Quote is re-run on the parent block at the protect block's time, so "repaid
exactly what quote said" compares the same moment. The receipt, the explorer links and the checks are written to
`packages/contracts/deployments/guard-prove-<date>.md`. It exits 0 only if every check passes.

`--clear` removes what the run left behind. The payer signs one Multicall3From batch: `clearRule` on the USDC
market (only if a rule exists) and an approval of 0 to AdagGuard. It has the same chain, record and market checks,
the same printed plan, typed `yes` and key handling, and the same receipt check. It then checks that no rule and
no approval are left, and appends its receipt to the same `guard-prove-<date>.md`. With nothing to clear it says
so and sends nothing.

### guard-attack.mjs

Each attack is its own simulation from the same block. It prints the attack, what should stop it, the decoded
result and PASS or FAIL, and appends the table to `packages/contracts/deployments/attacks-<date>-guard.md`. It exits 0
only if every row passes. The C numbers are the threat model's invariants, with Ram's amendments: a rule is a
trigger, a target and an expiry, and the approval is the lifetime ceiling.

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

State overrides are used for two things only: native USDC for the simulated stranger, and in G8 and G9
`mock/MockOracle.sol` at the market oracle's address, labelled as a simulated crash. AdagGuard and Morpho state are
never overridden. G7 lowers the payer's balance with a real transfer inside the simulation, not an override.

Run against the live contract at block 22863638: 14 of 14 rows passed. The run from before the deploy, against
the local build, is in the same file at block 22858500, also 14 of 14.

### verify-guard.sh

With AdagGuard recorded, the script takes these steps:
- It writes `deployments/<deploy day>/AdagGuard.standard-json.json` with `AdagGuard.abi.json` beside it.
- Before anything is submitted, it compiles that input again with solc 0.8.30 and checks it rebuilds exactly the
  runtime code of the local build and the code on chain.
- It submits to Sourcify, and to Etherscan (ArcScan) only when `ETHERSCAN_API_KEY` is in the repo `.env`.
- It prints the manual explorer.arc.io upload steps, because that explorer blocks scripted submissions.

`bash packages/contracts/verify-guard.sh --dry-run` does the build and the bytecode check in a temporary folder,
sends nothing and writes nothing in the repo. It builds into `out-guard` and `cache-guard`, never the shared `out`.

### What the AdagGuard scripts do not cover

- A real signed protect. These commands simulate against the live contract; they do not send one.
- Liquidations racing a protect, token pauses, Circle's blocklist, and the keeper service itself.
- Prices other than the live one and a crash to zero. The fork tests in `packages/contracts/test/AdagGuard*.t.sol`
  cover random prices, allowances and balances.
