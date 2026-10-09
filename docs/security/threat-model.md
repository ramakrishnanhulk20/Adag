# Adag threat model

Written at the architecture gate on 25 September 2026, before any contract code, and kept current as the code lands. Method: a pre-implementation design review, run from a plain functional description of the system, with security deliberately left out of that description so the review had to reason from scratch. Section C is the definition of done: the implementation is complete only when every invariant in it is shown to hold, each with the file and function that upholds it and a test that attacks it.

What Adag is, in one paragraph: a web app and smart contracts on Arc mainnet. A person holding cirBTC pays a bill in USDC or EURC in one signed transaction. That transaction pledges cirBTC on Morpho Blue, borrows the bill amount, and pays the person who issued the bill, with the bill's reference attached through Arc's Memo contract. The transaction is refused if the loan would pass 40% of the bitcoin's value (Morpho liquidates at 86%). Each bill can be paid once. Bills can also be paid from an existing USDC or EURC balance.

---

## A) App-class risk profile

### What kind of system this is

In security terms, Adag is three systems sharing one name, plus an optional fourth.

1. **A blind transaction builder.** A web page assembles a batch of calls, and a person's wallet signs the batch once. The wallet shows a hex blob for Multicall3From, so the payer cannot check what they sign. Whatever the page builds, the payer's money does.
2. **A public, permissionless record book.** Strangers write records (bills), other strangers act on them (pay), and anyone reads them. There is no login. The record is the only thing that connects the person who ships goods to the person who pays.
3. **A renderer of untrusted content to people about to make a payment decision.** Bill links, reference text, addresses and amounts arrive from URLs, from chain storage and from event logs. The page shows them to the payer as "this is who you are paying and how much".
4. **Optionally, a small custodial service:** a hot wallet that spends its own USDC on fees for strangers.

### Vulnerability categories that bite this class, tied to Adag's data flows

1. **Calldata construction and blind signing.** This applies, and it is the largest risk. When paying from bitcoin, the payer signs one Multicall3From transaction carrying approve, supplyCollateral, borrow, a Memo-wrapped payment and the Adag step. A bug in how the app picks a target address, a receiver, an approval amount or an allowFailure flag is a direct loss of the payer's cirBTC or stablecoins. A compromised page (a dependency, the hosting, DNS) has the same power. The wallet cannot save the payer here.
2. **Replay and double-pay of records.** This applies. A bill id must mean one bill and one payment. Under the link model, a signed bill can be presented twice: by two customers, on another contract, or after a redeploy. Under both models, a batch can list the same id twice. A second customer paying an already-paid bill loses money unless the contract refuses.
3. **Forged or ambiguous authorship.** This applies. The create form asks the payee for "their own address". If the contract accepts a payee address from the form instead of taking the sender, anyone can write bills that name a victim as payee, filling the victim's dashboard with bills they never issued. Under the link model, the payee is whoever the signature recovers to, so several things become authorship bugs: a zero-address recovery, a malleable signature, and a contract-wallet payee that cannot sign.
4. **Phishing through shareable links.** This applies. A bill link carries a payee address and a reference that says "Rent, March". Nothing in Adag can say whether that address belongs to the landlord. This is partly a non-goal, but the rendering rules below shrink it: the page shows exactly what will be paid, to exactly which address, from the same bytes the transaction uses.
5. **Content injection.** This applies. The reference is 140 free bytes written by a stranger. It is rendered on the bill page and both dashboards, and copied into the Memo event's data, where explorers and indexers pick it up. HTML, script, right-to-left overrides, unicode look-alikes of addresses, and invalid UTF-8 are all valid 140-byte strings.
6. **Parameter injection through the URL.** This applies under the link model, where the URL is the bill. Any query parameter the app turns into a contract address, token address, chain id or receiver is a drain path: the attacker's link makes the payer approve the attacker's contract.
7. **Numeric and oracle errors in the loan check.** This applies. The Adag step reads the payer's Morpho position (in shares), the market totals and the oracle price, then compares debt to 40% of collateral value. There are four places to be off by a power of ten: share-to-asset rounding, interest not yet accrued, cirBTC's 8 decimals against the stablecoins' 6, and the oracle's scale factor. Wrong in one direction, every payment reverts. Wrong in the other, the payer borrows past the line the product promised.
8. **Trust in sibling calls.** This applies. The Adag step is the last call in a batch the payer composed, and the payer chooses which calls run and in what order. A design where Adag remembers a balance from an earlier call and compares it later can be spoofed. The payer runs the earlier call in a different transaction, waits for the payee's balance to rise for another reason, then runs the later call.
9. **Fake proof of payment in logs.** This applies. The Memo contract is public, and anyone can emit a Memo event carrying any bill id. A dashboard that counts Memo events with a given bill id as payments is counting attacker output.
10. **Untrusted upstream data.** This applies. The public RPC, Morpho's GraphQL API and any indexer feed the UI and the pledge-size calculation. A wrong or malicious answer produces one of two failures. A wrong pledge size is caught by the on-chain check, so the payment reverts. A wrong paid or unpaid display is worse: the payer may pay twice, and only the contract's refusal saves them.
11. **Hot wallet drain and fee griefing.** This applies only if the fee sponsor ships. Attackers send the sponsor transactions that revert, or thousands of tiny valid ones, and the sponsor pays the fee for each. A replayed or over-broad signed authorization lets the sponsor, or someone who steals its key, move the payer's tokens somewhere other than the bill.
12. **Admin key compromise.** This applies only under the owner option. An owner who can change the market ids or the 40% limit can point Adag at a market with a friendly oracle or a fake loan token. Payments would then "succeed" in a worthless currency.
13. **Reentrancy.** The risk is low. Adag holds no funds and the tokens have no transfer hooks. It still applies as discipline: the paid flag is set before any external call, so nobody can observe "unpaid" after money has moved.
14. **Issuer controls on the tokens (blocklist, pause).** This applies as a fail-closed case, not a loss. A blocklisted payer or payee makes the transfer revert, and the whole batch undoes itself. The UI must explain the revert, and no one may be able to mark a bill paid when the transfer reverted.

### Categories that do not apply, and why

- **Server-side request forgery:** the app fetches fixed endpoints (the Arc RPC and Morpho's GraphQL), never a URL a user supplies.
- **SQL or query injection:** there is no database and no user-driven query. An indexer, if built, only appends from chain logs.
- **Authentication and session bugs:** there are no accounts, passwords or sessions. The wallet signature is the only authority. (For the components added on 26 September this no longer holds: alert links are written by signed messages, C46 and C47.)
- **Classic CSRF:** no server holds state that a forged request could change. (For the components added on 26 September this no longer holds: the alert store is server state, C47.)
- **Multi-tenant data isolation:** every bill is public on chain by design, so there is no private data to leak between users. Privacy is a named non-goal. (For the components added on 26 September this no longer holds: the wallet-to-chat table is private, C49.)
- **File upload and path traversal:** there are no files.

---

## B) Threat model

### Trust boundaries

1. **URL to page.** Every character after the domain is attacker-written.
2. **Page to wallet.** The page hands the wallet calldata to sign. The wallet trusts the page because the payer clicked; the payer cannot read the calldata.
3. **Payee's form to the bill record.** Under on-chain storage, the boundary is the create transaction. Under the link model, it is the typed-data signature, and the record stays off-chain and unverified until the pay transaction.
4. **Chain to page.** RPC responses, event logs and Morpho's GraphQL are inputs the page renders and computes with. The RPC is a third-party server.
5. **Payer's batch to Adag.** Through Arc's CallFrom, the sender Adag sees is the payer's wallet. Every argument, and every earlier call in the batch, is chosen by the payer.
6. **Adag to Morpho, the oracle and the token contracts.** Their return values are Adag's inputs. Adag trusts them to be honest (a non-goal) but not to be well-formed: a zero price or a reverting read is still an input.
7. **Adag to its own events, then to indexers, explorers and dashboards.** Everything emitted becomes someone else's input.
8. **Internet to the sponsor service, to the hot wallet, to the chain.** The sponsor is the only place a private key sits on a server.
9. **Build pipeline and hosting to the JavaScript served.** Dependencies, Vercel and DNS.
10. **The wallet's current chain to the page's assumption of chain 5042.**

### Attacker-controlled inputs

Direct:
- **Bill fields:** payee address, currency, amount, due date, reference bytes, and the salt or nonce. Under the link model, also the signature bytes and the full struct.
- **Bill link parameters:** their length and encoding, and any parameter the app was not expecting.
- **The bill id** passed to the pay step, and the batch of bills (its length, order and duplicates).
- **Every argument of every call in the batch:** amounts, receiver and onBehalf addresses, market params passed to Morpho, the allowFailure flag on each call, and the target address of each call.
- **The sender's identity:** any wallet. That includes the payee's own wallet paying its own bill, and a wallet that already holds Morpho positions Adag did not create.
- **Sponsor API bodies:** transactions to sponsor, signed authorizations, EIP-7702 delegation signatures, and claimed sender addresses.
- **The wallet's chain id and selected account** at the moment of signing.

Indirect:
- **The oracle price at execution time.** It can differ from what the page computed with, and it can be zero, huge, or revert.
- **The payer's Morpho position and the market totals.** The payer can change them in the same transaction before the Adag step: supply, repay, borrow more, withdraw.
- **Token balances of the payee,** which other senders can change in the same block.
- **Stored data read back later:** bill data (reference, payee, amount, currency) stored earlier, and any stored snapshot read in a later call.
- **Memo events** from any sender, with any bill id and any data.
- **Third-party answers:** RPC responses (malicious or merely broken), GraphQL responses, indexer output, and swap quotes from App Kit or Uniswap.
- **Token contract state:** the blocklist, pause, and any upgrade the issuer performs.
- **The payer's account code** under an EIP-7702 delegation.
- **The block timestamp,** if the due date is ever compared to it.
- **Recovered signer addresses.** They depend on attacker-supplied signature bytes and can be address zero.

### Privileged position and assets

- **The Adag contract.** It holds no tokens, but it holds two valuable things: a momentary token allowance from the payer during the pay call, and the paid flag, which is the truth a payee ships goods against.
- **The web page.** It writes what the wallet signs. If the page is wrong or compromised, it can spend everything in the payer's wallet, because the payer signs a blob.
- **The sponsor.** It holds a private key and a USDC balance, and it can submit transactions that carry other people's signed authorizations.
- **The operator.** It holds:
  - the deploy key, used once and then irrelevant if there is no admin;
  - the Vercel account and DNS;
  - the environment variables;
  - under the owner option, a live key that can repoint the contract.
- **The indexer.** It holds what the dashboards show, and it can lie by omission.
- **The loan check.** Adag does not hold the position, but its arithmetic decides how close the payer is pushed toward Morpho's 86% liquidation line.

### Attacker goals, highest value first

1. **Drain the payer through the transaction builder.** Enabled by the pay, batch, repay and sponsor flows:
   - a URL parameter that becomes a target or token address;
   - an approval to the wrong spender, or for more than the amount;
   - a receiver that is neither the payer nor the payee;
   - an EIP-7702 delegation to attacker code;
   - a compromised page.
2. **Get a bill marked paid without paying.** Enabled by any of:
   - the Adag step trusting sibling calls, for example a stale snapshot;
   - allowFailure set on the transfer;
   - a zero-amount bill;
   - a bill whose currency is a worthless token;
   - a rounding path where the amount moved is less than the bill;
   - a dashboard that treats Memo events as payment.
3. **Get paid twice, or get someone else's payment.** Enabled by any of:
   - replaying a signed bill;
   - an id collision;
   - an edited link whose displayed payee differs from the signed payee;
   - a redeploy that reuses ids;
   - a batch listing one bill twice.
4. **Phish through a link.** A bill names the attacker as payee, and either carries a reference that impersonates a merchant or one that renders as HTML or as a fake address.
5. **Push the payer past 40%, or block every payment.** Enabled by errors in the loan check: the oracle scale, share rounding, interest not yet accrued, a decimals mismatch, or checking the wrong market.
6. **Drain the sponsor.** Enabled by reverting transactions, sheer volume, replayed authorizations, or theft of its key.
7. **Under the owner option, steal the owner key** and repoint the markets, the tokens or the limit.

---

## C) Defensive-programming standards (definition of done)

Each invariant is an outcome, not a step. It is cited by number beside the file and function that upholds it, and a test shows it holding under attack. Where the design had an open choice, a "Choice" line says which option makes the invariant easier or harder.

### Money movement

**C1.** A bill is marked paid only when the payee's balance of the bill's currency rose by at least the bill amount within the same call that marks it paid. Both readings come from the token contract, one before the transfer and one after. No reading stored by another call or another transaction counts. A payer who is also the payee produces a zero rise and is refused.
Choice: easy if the loan goes to the payer and Adag then moves the amount, since Adag does the transfer and measures it in one function. Hard if the loan goes straight to the payee, which needs a snapshot from an earlier call. That is only safe in transient storage that dies with the transaction; a stored snapshot can be spoofed.

**C2.** The only token movement Adag can cause is the exact bill amount, from the sender, to that bill's payee, in that bill's currency, within the call that marks that bill paid. Adag never holds tokens between calls, has no function that moves tokens for any other reason, and never needs an allowance larger than the amount in flight.
Choice: trivially true if the loan goes straight to the payee, since Adag moves nothing. If the loan goes to the payer, it is the scope of Adag's single transfer.

**C3.** Every call in a batch the app builds follows these rules. No address, chain id, selector or amount in any call is taken from the URL or from any upstream response.
- It targets one of the addresses fixed at build time: Adag, Morpho, Memo, Multicall3From, or the three tokens.
- Every approval goes to Morpho or Adag only, for exactly the amount that batch uses.
- Every allowFailure is false.
- Every onBehalf and receiver is the payer. The one exception is a borrow receiver that is the payee read from the verified bill.
- From a link, the app reads exactly one thing: a bill id, or a signed bill and its signature.
- Amended 9 October: every batch the app builds or re-checks before signing (a wallet batch, a conversion or a Safe MultiSend) holds only calls its own builders write, each read back with the fixed ABIs to the exact same bytes: on a token, only an approval to Morpho, to the AdagBills a paid bill is on, to the guard at 0 in a close, or to the adapter in a conversion, plus a conversion's one balance-check transfer; a Memo pay(id) only for a bill that batch pays, under that bill's memo id; only Morpho's four loan calls, on Adag's two markets, for the payer, with no callback data; direct AdagBills calls only from a Safe, to pay its own bills or to enrol alone; and on AdagGuard, only the closing loan's exact clearRule. Upheld by assertCallShapes, called from assertCalls in packages/web/src/lib/pay/build.ts; with that call switched off, 14 refusal tests fail.

Choice: on-chain bills make the link a single id, the smallest surface. Signed links carry the whole bill, so the bill must be verified before any field is used.

Scope (added at the backend review): C3 and C4 bind every script that signs, including `prove-it.mjs` and `deploy.sh`, not only the web app. Market params placed in a signed call are proven by hashing them to the fixed market id, never trusted from an RPC answer.

Amended 6 October (C65 to C68): one scoped exception. A batch that carries a conversion may contain exactly one call to Circle's swap adapter, with an approval to it of exactly the amount sold. The adapter is on neither the target list nor the spender list. A separate rule holds that one call to C65 to C68, and without a conversion any call or approval to the adapter is refused, even one wrapped in Memo or a batch inside the batch.

**C4.** The app builds no transaction and requests no signature unless the wallet reports chain id 5042. Every typed-data domain names chain 5042 and the deployed Adag address. A bill signed for another chain or another Adag deployment cannot be paid here.

### Bill identity and replay

**C5.** A bill id is computed from the full bill content, the payee, a fresh nonce or salt, chain id 5042 and the Adag address, by one encoder that the contract owns. The UI shows only ids it recomputed from content with that same encoding, never an id it received in a link.
Choice: with on-chain bills the contract assigns the id and the UI only reads it, which is easiest. With signed links, the id is the typed-data hash, and the UI's encoder must match the contract's byte for byte.

**C6.** A bill is marked paid at most once, through any entry point: single pay, batch pay, or the sponsor path.
- The paid flag is written before any external call.
- A batch that lists the same id twice reverts as a whole.
- A paid signed bill cannot be paid again: not with the same signature, a differently encoded signature, or a re-signed copy of the same content.

Choice: the same under both storage models: one set of paid ids on chain.

**C7.** A bill's payee is the account that wrote it: the sender for an on-chain create, the strictly recovered signer for a signed bill. The payment is refused if the recovery yields address zero, the signature has a high s value, the signature is not exactly 65 bytes, or the bill's typed-data domain differs from Adag's. Recovery uses the standard library's strict recovery, never raw ecrecover.
Choice: with on-chain bills, "payee is the sender" is one line. With signed links, it needs strict signature checks, and a contract wallet cannot be a payee unless contract-signature support (EIP-1271) is added on purpose.

**C8.** No payable bill can exist with any of these:
- an amount of zero;
- a currency that is not the loan token of one of the two fixed Adag markets;
- a payee of address zero;
- a reference longer than 140 bytes.

The contract enforces this at the moment it matters: at creation for on-chain bills, at payment for signed links. The form's own validation is a courtesy, not the guard.

**C9.** Only a bill's payee can void an unpaid bill, and a voided bill can never be paid. Without a void, a mistaken bill stays payable forever.
Choice: with on-chain bills, a state flag. With signed links, an on-chain set of voided ids; otherwise a signed bill can never be recalled.

### Loan safety

**C10.** After the payment step, the payer's debt is at or under 40% of their collateral value, in the market whose loan token is the bill's currency.
- **Debt** is borrow shares converted to assets, rounding up, after interest is accrued in the same transaction.
- **Collateral value** is collateral times the oracle price divided by the oracle scale, rounding down.
- The comparison is done in integers with no intermediate overflow.
- The check reads live Morpho and oracle state. Nothing the caller passes in can substitute for it.

Amended 6 October (C69): when a bill is paid from a loan in the other currency, the market that gained debt is the other currency's, and the contract checks that one. The contract is unchanged: it checks whichever market gained debt.

Choice: with no admin, the 40% and the market ids are constants, which is easiest. With an owner, they are storage, and every change must emit an event and take effect only after a delay.
Decided at the gate (25 September): **the new-debt rule.** On every payment, for both Adag markets, Adag compares the payer's live position with the last one it recorded for that payer and market.

Amended at the pre-deploy code review (25 September). The first version compared borrow shares alone. A separate review showed it could be skipped: pay once, close the loan outside Adag, then re-open it with exactly the recorded share count against far less collateral. The rule now records both borrow shares and pledged collateral:
- The check runs whenever debt is above zero and the position is not at least as safe as the recorded one, meaning shares went up or collateral went down.
- A position with no more shares and no less collateral than one Adag already accepted skips the check. It can only be worse than that position through price or interest drift, which is exempt by design.

So the check runs whenever the loan has become riskier by the payer's own action, and no argument can skip it.

Why this holds: Adag only overwrites a recorded position without a check when the new one has no debt, or is dominated by the old one (no more shares, no less collateral). Every unchecked position with debt is therefore dominated by the last position a check accepted. Invariant I7 asserts this over random action sequences that include the bypass attempt; with the old shares-only rule restored, I7 fails within 5 calls. One cost is named: a payer whom Morpho partly liquidated has less collateral than recorded, so their next Adag payment is checked, and it is refused while they sit above 40%. That fails closed. A cash payment with no new debt is never blocked by a price drop. Proven against the deployed contract on mainnet state by the attack suite (`packages/contracts/deployments/attacks-2026-09-25.md`): after a simulated 25% price drop, a cash payment with the loan at 50.78% goes through while a small new borrow is refused (A9a, A9b), and borrowing to about 50% in the same batch as a payment is refused (A3).
Residual, named: the check runs at the moment Adag's step executes. A payer who hand-builds a batch can still borrow more or withdraw collateral after that step, putting only their own position at risk (see the non-goal "A payer who goes above 40% by using Morpho directly"). The residual lasts only until that payer's next Adag payment. The extra debt was never recorded, so it counts as new debt then, and the payment is refused while it sits above 40%. `test_residual_borrowAfterPayIsNotCaught` asserts the first half (the batch succeeds and nothing is recorded). `test_unseenDebt_above40IsRefused` shows the second (unrecorded debt above 40% is refused on the next payment). A payer whose debt Adag has never seen is checked on their first payment, so existing Morpho borrowers above 40% cannot pay through Adag until they are below 40%.

**C11.** The payment step reverts if any read the check needs reverts, if collateral value computes to zero while debt is above zero, or if a fixed market id does not resolve to the expected loan and collateral tokens. Unreadable means over the limit.

**C12.** The market params Adag passes to Morpho are exactly the ones Morpho returns for the fixed market ids. No argument from the caller can select, alter or substitute a market.

**C13.** The pledge size the app proposes is a suggestion with a stated margin; the contract's check in C10 is the guard. If the price moves between page load and the block, the transaction reverts. That is never a loss and never a silent over-borrow.

**C24.** New debt is accepted only if every nonzero feed that the market oracle's `price()` reads has a positive answer and an update time within its window: 26 hours for BTC/USD, 96 hours for EUR/USD. A fork test pins the oracle layout this assumes: no vaults, no second base feed, no second quote feed, and a quote feed only on the EURC market. Both oracles are immutable, and their addresses are part of each fixed market id, so the layout cannot change under a deployed Adag. (Added at the backend review; until then freshness was a design note, not a numbered invariant.)

### Added at the final review (26 September)

A third review, made once the app was built, read its money paths, its API routes and the proof script. It proposed six invariants for the app layer that the standard above did not yet state. Each names the flow it guards and where it is upheld.

**C25. Fee and principal from one balance.** Before a signature is requested, the payer's USDC covers every USDC the batch moves out plus the worst-case fee, because Arc pays gas from that same balance. It guards every payment from a USDC balance, one bill or a basket of them. Upheld by `simulateAndSend` in `packages/web/src/lib/wallet/send.ts`: its usdcOut check requires the native balance to be at least gas times maxFeePerGas plus the USDC the batch moves out. Prompted by a finding: paying from balance was offered with no fee reserve, so a payer holding exactly the bill amount was offered a payment Arc could not carry out. Fixed before release.
Amended 6 October (C68, C71): for a conversion, USDC approved to the swap adapter counts as leaving the wallet, and the only credit is USDC borrowed earlier in the same batch for that swap (`conversionUsdcOut` in `packages/web/src/lib/fx/plan.ts`). USDC the swap returns is credited at its minimum and spent on the bills or the loan repayment, so it nets to zero. The fee reserve is the fixed gas ceiling times the fee ceiling the batch was built with.

**C26. Consent to the funding source.** Whether a payment draws on a balance or opens a loan is the payer's choice and is never substituted by the app. A choice that becomes invalid is cleared, not replaced. It guards the basket of several bills, where the source is chosen per currency and the numbers refresh while the payer decides. Upheld by the funding-choice effect in `packages/web/src/components/app/Basket.tsx`. Prompted by a finding: the basket's 30-second refresh could switch a payer's chosen source from balance to bitcoin without a click. Fixed before release.

**C27. Signer identity.** No signature is requested unless the connected account equals the account every onBehalf, receiver and balance check used. It guards every batch the app asks a wallet to sign, including after the wallet switches accounts between reading and signing. Upheld by the connected-account check in `simulateAndSend` in `packages/web/src/lib/wallet/send.ts`.
Amended 6 October (C66): the plan's beneficiaries are on this list too. Every beneficiary in a swap plan is the connected account, and a conversion built for another wallet is refused before it is sent (`assertConversionBatch` in `packages/web/src/lib/pay/build.ts`).

**C28. Interest accrual on repay.** Any debt figure shown or approved is accrued to the current block from the market's rate and lastUpdate, with a margin only for the seconds before the block. It guards closing a loan and every debt figure on the wallet page. Upheld by `accrueBorrowAssets` and `closeApproval` in `packages/web/src/lib/pay/loan.ts`. Prompted by a finding: the loan close sized its approval from Morpho's stored totals, which leave out the interest since the market's last update, so a close could revert for want of a few units of approval. Fixed before release.

**C29. The displayed amount bounds the approval.** Every approval the app builds is at most what the payer was shown, so a wrong upstream answer can only make a payment revert. It guards every payment and loan batch. Upheld by the builders in `packages/web/src/lib/pay/build.ts`, which take each approval exactly from the bill record the payer was shown.
Amended 6 October (C66, C67): the approval to the swap adapter is exactly the amount the payer was shown being borrowed and converted. Before a conversion is offered, the payer's standing allowances to the adapter for all three tokens, and any Morpho authorisation of it, must read zero.

**C30. Over-approval reset.** An approval above the amount used is reset to zero in the same batch, and no approval outlives a batch. It guards closing a loan, the one batch that approves more than it uses: the live debt plus a margin for accrual. Upheld by `buildCloseLoan` in `packages/web/src/lib/pay/build.ts`, whose last call approves 0.
Amended 6 October (C67): the approval to the swap adapter is set back to 0 by the last call of a conversion batch, and `assertSwapCalls` refuses any batch that ends with it open. After the batch, the allowances to the adapter for USDC, EURC and cirBTC and its Morpho authorisation are read back and must all be zero.

### Added before the second build (26 September), written before any of its code

A separate reviewer wrote this part before any code for four new components existed, working from a plain functional description of them: a second AdagBills deployment that lets an existing Morpho borrower enrol, AdagGuard, alerts, and Safe payments. The new bill contract keeps the name AdagBills. Below, v1 is the first deployment, which stays live, and v2 is the second. C31 to C57 are the definition of done for these components, and they are being built against it. Where a decision made after the review changed an invariant, the invariant says so.

**Decided since the review.**
- AdagGuard is the allowance design: the reserve stays in the borrower's wallet, approved to AdagGuard, which pulls only what a protection repays (C35).
- A rule is (trigger, target, expiry). There is no per-protection maximum and no cooldown. Each protection repays only what brings the loan back to the target, and the approval is the lifetime ceiling (C36, C38).
- Rule holders are an on-chain enumerable set in AdagGuard (C43).
- With two deployments that both number bills from 1, a bill's identity is the pair (contract, id), everywhere (C33).

#### Design gaps the review raised, most severe first

1. AdagGuard's "maximum repayment per protection" is not a ceiling. protect is public and repeatable, so the true ceiling is the allowance. The review offered two fixes: add a per-rule cooldown, or state plainly that the allowance is the cap. Adag took the second (C38).
2. The keeper's rule list fed by webhooks into a store: a forged "rule cleared" event silences a real borrower. Verify webhook signatures and rebuild from chain on a schedule; an enumerable set of rule holders in AdagGuard makes the rebuild a paged read (C43, C44).
3. v1 and v2 both number bills from 1. Identity must be the pair (contract, id) through one parser (C33).
4. Safe transactions: gasPrice, gasToken, refundReceiver zero; the outer delegatecall only to the canonical MultiSendCallOnly; safeTxGas zero so an inner failure reverts instead of consuming the nonce (C51, C54).
5. The Telegram link signature must name the chat it binds to, and the bot webhook must verify Telegram's secret token (C44, C46).
6. The same-block enrol refusal is a speed bump: borrow and enrol in block N, pay in block N+1. Only the payer's own position is affected. Public wording: "a payment through Adag is never the action that takes a position above 40%" (C32).
7. protect's repay cap must use debt rounded down while the loan-to-value test uses debt rounded up, or a full repayment underflows in Morpho (C36).

#### What this changes in C1 to C30

- C3's fixed target list grows (v2, AdagGuard, MultiSendCallOnly) and binds the Safe builder and the keeper.
- C5 and C16 name one Adag address. With two contracts, a bill is (contract, id), and "paid" is filtered by the bill's own contract (C33, C53).
- C25's fee reserve must count a pending protection as an outflow (C45).
- C21's rate-limit shape applies to the keeper (C42).
- The non-goal "watching the position after payment" is now half true: AdagGuard and alerts watch it, within the non-goals below.
- Authentication, CSRF and multi-tenant isolation, listed in section A as not applying, now apply: signed messages are the auth, unauthenticated store writes are the CSRF, and wallet-to-chat is private data (C46, C47, C49).

#### Open questions, to settle before the code

- Whether Multicall3From refuses a contract sender (known: CallFrom needs sender equal to tx.origin, which is why the Safe path exists).
- The Safe singleton, MultiSendCallOnly address and Transaction Service on Arc. Safe v1.4.1 was found live on Arc; the addresses are being confirmed.
- Whether a Safe can link alerts, since it signs messages only through EIP-1271.
- The current bill link format, which decides how a bare id is read (C33).
- Whether a standing USDC allowance pull can leave the borrower with no gas (copy in the non-goals).

#### A) App-class risk profile, extended

New classes, numbered on from the four in section A:

5. **A pull-payment executor.** AdagGuard holds standing token allowances from many borrowers and has a public function that spends them. The allowance is the asset.
6. **An event-driven automation service with a hot wallet.** The keeper reacts to webhooks and a schedule, reads a store it did not fully write, and signs with a server key.
7. **A sender of messages to third-party inboxes.** The Telegram bot's name is a trust signal; anything that lets an attacker choose what it says, or to whom, makes it a phishing channel.
8. **A builder of transactions for a multi-signer account.** The app assembles a batch a Safe executes hours later.
9. **A multi-tenant store of private mappings.** Wallet to chat, link codes, thresholds, keeper state, behind server routes with no login.

Categories that bite, tied to flows:

1. **Allowance drain** through protect to transferFrom to Morpho.repay: a market argument resolving to the wrong loan token, a repay onBehalf that is not the borrower, a second token path, a cap from the wrong figure, repeated calls.
2. **Griefing with the borrower's own money:** repayment at a bad time, or emptying USDC needed for gas or a signed payment.
3. **Forged, replayed or dropped webhooks** on the RPC-provider route and the Telegram route.
4. **Keeper gas drain:** rules that look actionable in simulation and are no-ops on chain; thousands of rules.
5. **Hot key and secret exposure:** keeper key, bot token (messages every linked borrower as Adag), RPC key, store credentials, webhook secrets; a NEXT_PUBLIC_ prefix ships any of them.
6. **Authentication without sessions:** every write about a wallet needs a fresh, single-use signature from that wallet.
7. **Multi-tenant isolation and privacy:** no route answers "is this wallet linked"; one address normalizer for keys.
8. **Message content injection:** alerts carry fixed strings and numbers only, parse mode off.
9. **Code guessing and binding confusion** in the link flow.
10. **Wrong-account and wrong-contract identity:** two id spaces; in a Safe payment the payer is the Safe, the signer an owner.
11. **Multisig transaction shape:** operation, gasPrice, gasToken, refundReceiver, safeTxGas, baseGas, nonce.
12. **Time-of-check to time-of-use:** Safe proposals execute hours later; the keeper simulates at one block and lands at another.
13. **Numeric errors in the guard's target math:** two roundings, a 1e36 oracle scale, three caps.
14. **Enrol as a bypass of the new-debt rule:** bounded to the payer's own position, disclosed.
15. **Race conditions in the store:** concurrent keeper runs, double use of a code.

Still not applicable: SSRF (fixed origins only, C57), SQL injection (no query language; key construction covered by C57), file upload (no files), reentrancy through tokens (no hooks; empty data to repay; nonReentrant anyway).

#### B) Threat model, extended

Trust boundaries, numbered on from the ten in section B:

11. Internet to the RPC-provider webhook route.
12. Internet to the Telegram webhook route.
13. Internet or scheduler to the keeper run route.
14. App routes to the store, and the store back to the keeper and alerts.
15. Keeper server to the chain.
16. Adag's bot to a borrower's phone.
17. Any caller to AdagGuard.protect, and AdagGuard to the allowance, Morpho and the oracle.
18. Any caller to AdagBills v2.enrol.
19. Owner's wallet to Safe typed data, and the app to the Transaction Service and back.
20. The Safe's execution, hours later.
21. v1 to v2.

Attacker-controlled inputs, direct: protect's borrower, market and timing; setRule's fields including nonsense values; enrol's sender and timing; webhook bodies and headers and their replay; link codes as sent to the bot; signed messages posted to link, unlink or set thresholds; threshold values; the Safe address; every field of a Safe transaction; bill ids in a Safe basket, duplicates and both contracts.

Indirect: store rows read back later; Transaction Service responses; Telegram API responses; the oracle price and feed times at the landing block; the borrower's allowance and balance at the landing block; Morpho totals and shares at execution; v2's recorded position after an earlier enrol; the Safe's nonce, owners and threshold at execution; bill status at execution; the paid RPC's answers to simulations.

Privileged positions: AdagGuard's standing allowances and repay right (the most valuable addition); the keeper wallet (gas only, if no role); the server's secrets; the store; the app's Safe builder; the bot's identity.

Attacker goals, highest value first: drain a borrower's allowance; silence or misdirect protection and alerts; move a Safe's funds somewhere other than the bill; pay the wrong bill or the same bill twice across two contracts; use Adag's bot for phishing; spend the keeper's gas; pay from an over-40% position through v2 (bounded, disclosed).

#### C) Invariants C31 to C64, the definition of done for the second build

AdagBills v2

**C31. Enrol scope.** No arguments; writes only the caller's own recorded position with exactly Morpho's values in that block; stores the block; moves no tokens; emits exactly what it stored. A test enrols from an attacker and asserts every other record is unchanged.

**C32. The line v2 keeps.** In any transaction that pays a bill, if live shares are above or live collateral below the last accepted or enrolled position, the 40% check runs on live state. A payer whose enrol block equals the current block is refused. Named residual: enrol in block N, pay in N+1 forgives the debt in between, own risk only. Public wording: "a payment through Adag is never the action that takes a position above 40%". Tests show the one-batch attempt reverting and the two-block path succeeding.

**C33. Bill identity across two contracts.** A bill is (contract, id) in every link, row, key, Memo interpretation, paid read and pay call; one parser; ambiguous links refused. A test shows v1 id 5 and v2 id 5 cannot build each other's payment.

AdagGuard

**C34. Rule ownership.** Only the borrower (or the Safe as sender) writes or clears its rule; protect writes nothing but the borrower's Morpho debt.

**C35. The only money path.** Pulled equals repaid on the borrower's own position in a fixed, verified market in that market's loan token; the approval to Morpho is exact and consumed in the call; AdagGuard's balance is unchanged after the call; no other function moves or approves tokens; mistaken transfers are stuck by design. Fuzzed balance-identity test. Decided: the reserve stays in the borrower's wallet, approved to AdagGuard; there is no vault.

**C36. Amount bounds.** At most the least of: the amount that brings the loan back to the rule's target (debt rounded up after accrual, collateral value rounded down, as loanToValue), the remaining allowance, the borrower's balance, and debt in assets rounded down. Zero means nothing moves and nothing is emitted. A full-repayment test does not revert on rounding. Amended: the review's list also held a per-rule maximum, dropped when rules lost their maximum (C38).

**C37. Price basis.** The trigger uses the market oracle's price() with no freshness gate, the price liquidation uses; a reverting price reverts protect; a zero price stays bounded by C36; documented.

**C38. The real ceiling.** A rule is (trigger, target, expiry) and nothing more. There is no per-protection maximum and no cooldown: each protect repays only what brings the loan back to the target (C36), so a second protect at the same price moves nothing, and the allowance is the lifetime ceiling. A per-rule cooldown was considered and dropped: in a fast fall it could block the second protection the loan needs, at the moment the guard exists for. The app never builds an unlimited or larger-than-typed approval; the screen says the most it can take is the allowance, and that a USDC rule can leave the wallet without gas.

**C39. No privileged role.** No owner, keeper role, pause, sweep or upgrade; the keeper can build exactly one calldata shape, protect(borrower, market) to the fixed address with a fixed market and zero value; tested.

**C40. Views equal action.** The "would protect now, by how much" view and protect share one computation; the keeper and the app act only on the view at the latest block; property test.

**C41. Rule validity.** Refuse target at or above trigger, zero trigger, trigger at or above the liquidation line, or a past nonzero expiry; expired rules are inert; the app warns when a new rule would act immediately. Amended: the review's zero-maximum check went with the per-rule maximum.

**C42. Keeper spend and concurrency.** A written worst-hour gas cap, per-borrower limits and backoff; single-flight runs with a lease and expiry; bounded borrowers per run ordered by loan-to-value; gas limit from a latest-block simulation; no lease, no signing.

**C43. The index is a hint.** The rule-holder list is rebuilt from chain, from AdagGuard's on-chain enumerable set of rule holders read in pages, at a fixed cadence; no store row is ever the reason to pull tokens; a forged or missed event delays protection by at most one rebuild interval. Decided: the review allowed either filtered logs or an on-chain set; Adag keeps the set.

**C44. Webhook authenticity.** Provider signature, Telegram secret token and cron secret verified over the exact bytes; body caps, timeouts, rate limits; unverified requests dropped without logging bodies; handlers idempotent.

**C45. A pending protection is an outflow.** The pre-signature balance check counts a rule that would act now. Amended 6 October (C69): it is read for the loan market of the payment, which for a converted bill is the other currency's market, not the bill's.

Alerts

**C46. Link binding.** A code from a cryptographic source with at least 128 bits, expiring in minutes, consumed atomically; the chat id is the one Telegram delivered it from on a verified request; a strict signature recovers to the wallet over a message naming the action, site, chain 5042, code, chat handle and id, and expiry; the wallet is never taken from a form; attempts rate-limited; a wrong code reveals nothing.

**C47. Signed writes only.** Every change to per-wallet server state carries a fresh signed message with a nonce and expiry, consumed once; unlinking from inside the chat needs no signature; thresholds validated as integers in a sane range.

**C48. Alert content.** Fixed strings, computed numbers and the fixed origin only; no chain free text; parse mode off; tested with HTML and Markdown references.

**C49. Privacy of the link table.** No route reveals whether a wallet is linked or any chat id; logs never hold codes or chat ids beside wallets; one normalizer for addresses and chat ids as keys.

**C50. Alerts computed like the contract, promised like weather.** Loan-to-value from loanToValue or the same arithmetic; best effort; a false alert can never cause a transaction.

Safe payments

**C51. Safe transaction shape.** To the canonical MultiSendCallOnly with delegatecall for that target only; inner plain calls to build-time addresses only; value 0, gasPrice 0, gasToken 0, refundReceiver 0, safeTxGas 0, baseGas 0; approvals exact to Morpho, AdagBills or AdagGuard; every onBehalf and receiver the Safe; no field from the service, a URL or an RPC; tested like C3.

**C52. Safe verification before signing.** Chain 5042; the address is a Safe of version 1.3.0 or later on chain; the connected account is an owner by isOwner; the nonce from the Safe contract; the signed hash equals getTransactionHash and the service's echo; EIP-712 only.

**C53. Status truth.** Paid comes from the bill's own AdagBills contract, never the service's executed flag or a MultiSend event.

**C54. Atomic at execution.** safeTxGas 0 and gasPrice 0 make any inner failure revert the whole execution without consuming the nonce; re-simulate from the Safe before the first signature; say the outcome is decided at execution.

**C55. Same rules, Safe as payer.** Enrol, setRule, approvals and pay by a Safe follow C31 to C41, C45 and C58 with the Safe as the account; an owner's wallet is never substituted for the Safe.

Server and secrets

**C56. Secrets stay on the server.** Keeper key, bot token, RPC key, store credentials, webhook and cron secrets only as server environment variables, none NEXT_PUBLIC_, checked in the build; the keeper wallet holds gas only.

**C57. Routes bounded, fixed origins only.** Body caps, timeouts, rate limits; fetches only to the RPC, Telegram, Safe's service and the store; every webhook, signed-message or service value parsed once into typed values before use; unparseable input dropped.

Added at the code review of the second build

**C58. A payment never trips the payer's own guard unseen.** Before a payment that borrows is signed, the app compares the loan-to-value it lands at with the payer's guard trigger for that market; at or above the trigger, it says in plain words that the guard will repay about how much of the wallet's USDC or EURC within minutes, before the signature. When the rule or the approval cannot be read, the payment is blocked with a plain sentence, and both are read again at the moment of signing. Amended 6 October (C69, C70): the loan-to-value, the rule and the approval are those of the loan market, so a dollar bill paid from a euro loan is compared with the euro market's guard rule, and the warning says that the guard repays only from the loan's own currency already in the wallet.

**C59. Keeper paging and filtering.** Each run reads a fixed number of holder pages from a stored cursor that wraps around; holders with no debt or no allowance are dropped with cheap reads before any quote; a fixed number are simulated and acted on per run; no holder can make the cursor skip another holder or loop.

**C60. Stopping removes the approval.** Clearing a rule in the app sets AdagGuard's approval to 0 in the same transaction, proven by reading the allowance back as 0; every screen that shows a rule shows the standing allowance beside it; a leftover approval with no rule stays on screen until it is 0.

Added at the final review

**C61. Rate limits never block their own flow.** Each route counts in its own bucket; a read or a poll that runs to its cap never spends the budget of the write it leads to. Tested by polling to the cap and then writing.

**C62. Error text is an output.** Every error a route returns is a fixed sentence or text this codebase wrote. No text from a library, an RPC, a service or fetch reaches a response, since it can carry a keyed URL or an upstream's words.

**C63. A run fits its time limit.** The worst-case keeper or webhook run, receipt waits and alerts included, fits inside the route's platform time limit, and the lease outlives that worst case, so a run is never cut off while another can start the same work.

**C64. The paid index never skips a block.** A block range counts as scanned only when the head and the logs come from the same endpoint and the range ends a safety margin below that endpoint's head. A failed or partial answer leaves the cursor where it was.

**General standards applied.** Market validity is v1's predicate; authority over server state is a strict signature; webhook validity is the provider's signature over the raw body; Safe targets are the build-time set plus MultiSendCallOnly; bill identity is a pair from one parser; debt has two roundings from one function; the view and protect share one computation; the three Safe hashes compared as the same bytes32; one normalizer for keys; thresholds in WAD units.

**Named non-goals.** Liquidation itself (no balance, no allowance, nobody calling, or a single jump past 86% defeats the guard; interest can cross the trigger between price updates); a borrower's own choice to sit above 40% through enrol across two blocks, or to fund a rule with gas money; the oracle being right; a malicious Safe owner; the availability or honesty of Safe's service, Telegram or the RPC provider; a compromised Telegram account or phone; a compromised server beyond what it holds; privacy of on-chain facts.

### Added before cross-currency payments (6 October), written before any of its code

A reviewer wrote this part before any code for the feature existed, working from a plain functional description: pay a bill from a loan in the other currency. A dollar bill is paid by borrowing euros on Morpho and converting them to dollars through Circle's swap inside the same signature, and a euro bill is paid the other way round. A loan taken this way can also be closed with the other currency. C65 to C75 are the definition of done for it. The feature was built against them, and each invariant below says where it is upheld and which tests attack it. The unit tests are in `packages/web/src/lib/fx/test`. `packages/web/scripts/check-fx.mjs` proves the guards on live Arc mainnet state, as checks F1 to F10. Where what shipped differs from the first wording, the invariant says so.

**Decided at the gate.**
- The conversion is Circle App Kit's Swap, run through Circle's swap adapter at `0x7FB8c7260b63934d8da38aF902f87ae6e284a845`. Adag asks Circle for a signed plan, checks the plan as bytes, and puts it in the payer's batch.
- It is always offered as a choice next to a loan in the bill's own currency, and only where the loan market has the cash to lend. The app shows both markets' free cash.
- A short conversion must never be paid from the payer's own money (C68). The mechanism is a built-in balance check, with no new contract. Right after the swap, the batch makes the payer send a floor amount of the swap's output currency to themselves, and that transfer reverts the whole batch unless the payer's balance really rose by what the swap was meant to deliver. The floor is the payer's balance read at build time, plus what the swap funds, minus, for a USDC output only, the most gas the transaction can charge up front.
- The measured residual of that check. On a USDC output, a swap that comes up short by up to gasLimit x (maxFeePerGas minus the effective gas price) still passes, because Arc takes gas from the same balance. With today's settings (a gas limit of 2,500,000 and a fee ceiling of twice the base fee plus 1 gwei) that is about 0.05 USDC, so in the worst case the payer's own money fills a gap of about five cents. Short by one unit more reverts, which check-fx F2 shows. On a EURC output the slack is zero. Any balance the payer receives from elsewhere between the read and the block also counts toward the floor.
- At most one conversion per batch, and never two groups converting in opposite directions. A basket has one swap or none, and nothing else in the batch adds to the swap's output currency before the balance check.
- Not offered to a Safe. Circle's plans last 10 minutes and a Safe's signatures take longer (C74).

#### A) App-class risk profile, extended

New classes, numbered on from the nine above:

10. **A client that runs calldata written by an upstream service.** The app puts a plan written by Circle into the payer's batch, where it runs with the payer's authority to spend. It runs through contracts that change without notice: an upgradeable adapter proxy, a Li.Fi Diamond that changes about weekly, and DEX pools. C3 and C18 forbade this. They now allow exactly one call, defined by C65 to C68.
11. **A sender of payer data to a third-party API.** The payer's address, the amounts and the timing go to Circle.
12. **The front end of a loan in a currency other than the bill's.** A payer who owes a dollar bill ends up owing euros, or the reverse.

Categories that bite, tied to flows:

1. **Running upstream calldata.** C3 and C18 forbid it for everything else.
2. **Allowance scope.** The spender rule checks who is approved, not what the spender then does.
3. **The payer's own balance silently filling a short conversion.** `AdagBills.pay` takes the bill from the payer's whole balance, so a short swap still pays the bill if the payer holds the difference.
4. **Slippage and front-running inside the borrowed buffer.**
5. **Ambient authority.** Third-party code runs inside a transaction whose origin is the payer.
6. **Shown and executed values parsed differently.** Circle's JSON summary against its calldata, decimal strings against base units, 18-decimal native USDC against the 6-decimal token, chain time against the browser's clock, the bill's market against the loan's.
7. **Consent drift.** A buffer raised after a refusal, or a rate that moves on refresh.
8. **Spoofed receipts.** Logs from third-party contracts, even a genuine BillPaid for a different bill, paid by code inside the swap path.
9. **Time of check to time of use.** Inside Circle's 10-minute plan, and between a simulation and the block.
10. **Availability and griefing.** Circle's shared keyless rate limit, and thin free cash in the loan market.
11. **Data exposure to Circle.**

Does not apply: oracle manipulation through the swap's pools (the 40% check reads Chainlink-based market oracles, not pool prices); SSRF or injection into the Circle request (a fixed URL, typed fields, no free text); server-side risk (nothing is stored, the request is made from the browser without a key, and the keeper never swaps); reentrancy into AdagBills (`pay` is nonReentrant and the swap runs before it); Safe payments (excluded, C74).

#### B) Threat model, extended

Trust boundaries, numbered on from the twenty-one above:

22. The page to Circle's API.
23. Circle's API back to the page: the first upstream answer that becomes executed calldata.
24. The payer's batch to the adapter, the Li.Fi Diamond and the pools.
25. The swap to `AdagBills.pay`: one balance, mixed.
26. Swap-path contracts to the receipt.
27. The chain's clock to the browser's clock.
28. An RPC simulation to the decision to ask for a signature.

Attacker-controlled inputs, direct: the funding choice per group and the basket mix; the bill's amount and currency, written by a stranger; and every byte of Circle's answer, meaning its status, headers, size and JSON, and inside the calldata the selector, each instruction's target, data, value, input and output tokens, approval amount and minimum out, the beneficiaries, the execution id, the deadline, the metadata, each token input's permit type, token, amount and permit data, the signature, and Circle's error text.

Indirect: the adapter's implementation, the Diamond's facets and pool state at the landing block; Morpho's free cash and feed freshness; allowances and Morpho authorisations the payer granted elsewhere; logs from any swap-path contract; the RPC's simulation answer and block timestamp; timing and shared rate limits; and a plan kept in page memory after a failed attempt.

Privileged positions: the page gives a third-party contract an allowance and runs its code in the payer's transaction, choosing the amount, the minimum out and the plan. The payer's wallet holds the borrowed currency and the bill currency. The payer's Morpho position in the loan market. The payer's privacy toward Circle.

Attacker goals, highest value first:
1. Take the borrowed amount and leave the bill paid from the payer's own balance.
2. Reach beyond it: another token, more than the amount, a permit type reaching other allowances, native value, a foreign beneficiary, or a leftover allowance.
3. Take the buffer, or inflate the amount borrowed.
4. Get the payer to sign something other than what they saw.
5. Fake success, or credit it to the wrong bill.

#### C) Invariants C65 to C75, the definition of done for cross-currency payments

**C65. One fixed call per plan, checked as bytes.** Each conversion is exactly one call to the adapter address fixed at build time, with execute's selector from a fixed ABI. The app decodes Circle's calldata with that ABI, checks the decoded values (C66), re-encodes them and refuses unless the bytes equal Circle's. Nothing from Circle's JSON summary is shown or used. The app writes the call itself from typed fields, and the token input in it is the app's own: one token, the exact amount, no permit. Upheld by `checkPlan` in `packages/web/src/lib/fx/plan.ts`, applied to every batch by `assertSwapCalls` in `packages/web/src/lib/pay/build.ts`. The adapter is not on the target or spender lists. A rule in `assertCalls` reaches it only for a batch that carries its conversion description. Tests: trailing bytes (even zeros), another selector, another target, a changed padding byte, the same plan twice, a call or approval hidden inside Memo or a nested batch, each refused.

**C66. The plan names this payer, this bill and this amount.** Exactly one token input, permit type 0, no permit data, the loan currency's fixed address, amount X, where X is the same number the batch borrows and approves. Every beneficiary is the connected account. The bill currency comes back with a minimum of at least the group's bill total. Every instruction's native value is 0. The deadline is at least 120 seconds after the latest block's timestamp, on Arc's clock and never the browser's. Instruction count and calldata size are under fixed caps (6 steps, 24 KB). Inner targets are not checked against a list, because Circle's route changes about weekly. C67 and C68 bound them instead. Upheld by `checkPlan` and by `prepareConvert` in `build.ts`. Tests: two token inputs, a permit, another token or amount, a foreign beneficiary, a nonzero value, a deadline under 120 seconds (and exactly 120 passing), a minimum below the bill, too many steps, each refused.

**C67. The swap reaches X of the loan currency and nothing else.** The adapter's only power over the payer during the batch is an allowance of exactly X of the loan currency, set by the call just before execute and set back to 0 by the last call of the batch. Before a conversion is offered, the payer's allowances to the adapter for USDC, EURC and cirBTC read 0 apart from that one, and the payer has not authorised the adapter on Morpho. Anything else blocks the conversion with a plain sentence and a one-signature reset. After the batch the same reads must show nothing open, and a failed read is not "clear". Every execute comes before every pay, and the batch holds no token call except approvals and the balance check. Upheld by `assertSwapCalls`, and by `adapterPreflight` and `exposureIsClear` in `packages/web/src/lib/fx/preflight.ts`. Amended 7 October: the reset is sent by `sendAdapterReset` in `packages/web/src/lib/wallet/send.ts`, which compares every call byte for byte with the only two it may hold (an approval of 0 to the adapter on USDC, EURC or cirBTC, and the withdrawal of the adapter's Morpho authorisation, each at most once) and refuses any other call before it runs the sender's wallet, chain and dry-run checks. Test: a reset with an extra call, a nonzero approval, another spender, the authorisation switched on, a duplicate or a nested batch, each refused. Proven on Arc by check-fx F3 and F4: a contract called from inside the batch tries every route it has to make Multicall3From or Memo act as the payer and move the payer's cirBTC, and the payer's cirBTC does not move, while a control from the payer's own batch moves one satoshi. The reason is named under the non-goals.

**C68. A short conversion fails the whole batch.** The batch succeeds only if the swap raised the payer's balance of its output currency by at least what it funds: the group's bill total, or the close amount in C75. The payer's own money never makes a short conversion succeed, apart from the gas slack on a USDC output named above. Upheld by `floorOf` in `build.ts` and `floorSlack` in `fx/plan.ts`. `assertSwapCalls` refuses a batch whose check is not a transfer to the payer, on the output currency, right after the swap, for exactly the starting balance plus the funded amount less the slack. An amount so small that the floor would be zero is not offered. Proven on Arc: F1 (the check passes when met, on EURC and on native USDC), F2 (short by one unit on EURC reverts, and so does short by the slack plus one unit on USDC), and F6 (a contract that keeps the borrowed euros in place of the adapter: with the check the batch reverts and the payee gets nothing, and without it the same batch pays the whole bill from the payer's own USDC).

**C69. One loan market per group, decided once.** The loan currency for a conversion is the other of the two fixed currencies. Every figure tied to a market reads that one decision: `collateralNeeded` and the pledge, the supplyCollateral and borrow parameters (proven by hash against the loan market's id), free cash, the price status before the option is offered, the loan-to-value afterwards, the guard-trigger warning (C58) and the pending-protection outflow (C45), and the debt on the wallet page. Where groups share a market, pledge, X and free cash use that market's total. Upheld by `loanCurrencyFor` and `readLoanPriceFresh` in `packages/web/src/lib/fx/estimate.ts` and by `prepareConvert`. The weekend pause of the EUR/USD feed now blocks a dollar bill paid from a euro loan, and it fails closed.

**C70. Shown equals signed, and X has a ceiling.** The batch carries exactly the figures on screen when the payer pressed pay: X, the pledge, the worst-case rate (the bill total divided by X), the debt currency and the loan market. Any change after the press needs a new press: a larger buffer after Circle refuses, a fresh pledge, a new plan after expiry. X never exceeds the bill total converted at the EUR/USD price AdagBills reads, times 1.015, and nothing is offered while that feed is past its 96-hour window. The estimate shows the worst case, exactly the bill and no surplus, and states three things: the debt's dollar cost moves with EUR/USD; the 40% line is checked only at payment; AdagGuard repays only from the loan's currency already in the wallet. Upheld by `maxAmountToSell`, `assertEurUsdFresh` and `worstCaseRate` in `estimate.ts`, by `prepareConvert`, and by `sendConversion` in `packages/web/src/lib/wallet/send.ts`, which checks the exact bytes about to be signed against what the builder decided. Tests: X over the ceiling, a feed one second past 96 hours, a buffer that is not a whole number of basis points from 0 to 150, each refused.

**C71. The simulation checks effects, not just success.** Before a signature, the sender simulates at the latest block with the batch's fixed gas and fee ceiling and refuses unless every Transfer log out of the payer is one of these: the cirBTC pledge to Morpho, at most X of the loan currency to the adapter, a bill amount to its own payee, a loan repayment to Morpho in a close, or the balance check's self-transfer. Each bill must show its BillPaid from its own AdagBills with the payer as payer. A native-value move must mirror a USDC token transfer. Upheld by `checkEffects` in `fx/plan.ts`, called by `sendConversion`. The RPC is not trusted: C67 and C68 are the guards, and this is the early warning. It does not see tokens that move without a Transfer log. Some nodes, Arc's own endpoint included, do not run the simulation. Amended 7 October: when none answers, or the answer is too slow, the conversion is refused with a fixed sentence ("We could not double-check this conversion just now. Nothing was sent. Try again in a minute.") and the wallet is never asked to sign. The earlier behaviour, signing on C67 and C68 alone and saying so afterwards, is gone. The screens still ask first whether the connection can trace transfers, as the early warning. Upheld by `simulationVerdict` and the `requireEffects` option in `sendConversion`, `packages/web/src/lib/wallet/send.ts`, which `simulateAndSend` sets for every conversion.

**C72. A conversion's logs are not evidence.** Paid status comes only from a BillPaid emitted by the bill's own AdagBills, with that bill's id and the connected account as payer. Any other BillPaid in the receipt is not this payment, even one from AdagBills. Converted amount, surplus and fee come from balance reads at the receipt's block, or from Transfer logs whose emitter is the fixed token and whose recipient is the payer. Upheld for paid status by `matchBillPaid` and `billPaidIn` in `packages/web/src/lib/pay/receipt.ts`, which the simulation check and the receipt share. Tests: a forged BillPaid from another address, a real BillPaid for another bill id, and one for this id with another payer, none counts.

**C73. Circle is one origin, bounded, parsed once and never quoted.** The only new fetch is a POST to `https://api.circle.com/v1/stablecoinKits/swap`, and the only change to the content security policy adds exactly that origin to `connect-src`. The request has a 20-second timeout, a response cap of 120,000 bytes, no credentials, no redirects and no referrer. It is built from typed values only: the two fixed token addresses, whole numbers, the connected account and a fixed chain name, never a bill reference or free text. The answer is parsed once into typed values, and an error, a non-2xx status, an unreadable body or "no route" becomes one of five fixed sentences, never Circle's words. Only Circle's numeric code for "no route" is read, to choose between two of those sentences. There is no second route and no silent fallback. One request per press, none on load or refresh. Amended 7 October: one press may repeat the identical request twice when Circle reports no route or rate limiting; nothing the payer sees or signs changes. The repeat is the same token in, amount, token out, minimum out and account, sent as the same bytes, after a wait of 1.5 seconds and then 3 seconds. Every other failure stays a single attempt, a repeat stops at the first answer that is neither of those two, and three of them in a row end in the fixed sentence. Keyless in the client. Upheld by `requestPlan` in `packages/web/src/lib/fx/circle.ts`. Tests: a non-2xx answer, an oversized body whether declared or found while reading, a redirect, a timeout, a body with a missing or mistyped field, each refused whole; two "no route" answers then a plan returns the plan, three return the fixed sentence, a 500 is never repeated, and every repeated body is byte for byte the first.

**C74. A plan only where it can land, each in its own window.** `buildSafeBatch` refuses any plan that asks for a conversion, however it is spelled, and any inner call to the adapter. Each plan is used for one signature request and never again, whatever happens next: a failed, declined or abandoned attempt needs a new plan. Upheld by `buildSafeBatch` in `build.ts`, `claimPlan` in `fx/plan.ts`, and the one-swap rules in `buildPayMany` and `assertSwapCalls`, which refuse a second converting group and a batch with more than one swap call. Tests: a Safe handed a conversion however it is spelled, the same plan claimed twice, two converting groups, each refused.

**C75. Closing a loan with the other currency follows the same rules, roles swapped.** The payer sells Y of the other currency, and C25 counts it when it is USDC. The swap's minimum out is at least the close approval (C28), and C65 to C68 hold with the loan currency as the output. The batch repays by shares as `buildCloseLoan` does, and the collateral leaves only after that full repay, in the same batch. Y never exceeds the close approval at the euro price times 1.015. Upheld by `buildCloseWithOtherCurrency` in `build.ts`. Proven on Arc by check-fx F7 (a real Circle plan) and F10 (the app's own code): the debt reads zero shares, the collateral is back with the payer, and every allowance reads 0.

**What check-fx covers and does not.** F1 and F2 prove the balance check and its measured residual. F3 and F4 attack Multicall3From and Memo from inside a batch. F5 and F6 run a real Circle plan for a 100 USDC bill paid from a EURC loan, then the same batch with a sink in place of the adapter. F7 closes a EURC loan with USDC. F8 pays a 3 EURC bill from a USDC loan, and reports SKIP when the USDC market has too little cash to lend. F9 and F10 repeat the bill and the close with the app's own code. Every step runs in `eth_simulateV1` on Arc mainnet state, and nothing is signed or sent. It does not cover a real transaction, MEV, a Safe, or what a wallet shows the payer.

**What this changes in C1 to C64.**
- C3 and C18: one scoped exception for the adapter call, defined by C65 to C68 (amended in place above).
- C10: the market that gained debt can be the other currency's (C69).
- C16: a paid event must match the bill's id and the payer, not only the emitting contract (C72).
- C20: the gas ceiling includes the swap, and a batch holds one conversion (C71, C74).
- C25: USDC approved to the adapter counts as outflow, and only certain inflows are credited (C68, C71).
- C27: the plan's beneficiaries are the connected account (C66).
- C29 and C30: the adapter, and all three tokens, are covered by the approval rules and the read-back (C66, C67).
- C45 and C58: both are keyed on the loan market (C69).
- The non-goal about front-running and MEV is corrected: a conversion's buffer can be extracted, bounded by the buffer (C70).

**Named non-goals for cross-currency payments.**
- **Circle's price inside the buffer, and MEV on Arc.** Unmeasured, and bounded by the buffer (at most 1.5%), the plan's minimum and the balance check.
- **The gas slack of the balance check.** On a USDC output the floor is lowered by the gas ceiling at the highest fee the batch allows, while Arc takes the gas limit at the fee it actually charges. A swap short by up to the gas ceiling times the highest fee minus the fee charged can pass, and the payer's own USDC fills the gap. With a ceiling of 4,000,000 gas and today's fees that is about 0.08 USDC.
- **Availability** of Circle's keyless API, Li.Fi and the pools. A failure means no payment through a conversion, never a loss.
- **A stolen Circle signing key, the adapter's upgrade admin or the Diamond's owner.** In one Adag batch they can reach at most X of the loan currency, less what the balance check forces back. Allowances the payer gave them in other places are out of scope.
- **Code inside the swap acting as the payer.** C67's protection rests on Arc's CallFrom rule: it accepts only a call whose sender is the transaction's origin, and only Memo and Multicall3From may call it. Code reached from inside the swap therefore cannot make either of them act as the payer. check-fx F3 and F4 prove it on Arc today. A change to that rule on Arc would reopen it, and Adag has no control over that.
- **Currency risk after payment.** The debt is in the loan's currency, and its dollar cost moves with EUR/USD. A 5% move is about $5 on a $100 bill, in either direction.
- **AdagGuard never converts.** It repays only from the loan's own currency already in the wallet.
- **Privacy toward Circle.** Circle sees the wallet address, the amounts and the timing of each request.
- **Weekend EUR/USD pauses.** They block euro-loan payments. The app fails closed.
- **A compromised page.** The same non-goal as before: a page that builds a harmful batch is not stopped by these invariants.

### Rendering and outputs

**C14.** The reference is stored, emitted and rendered as opaque bytes shown as plain text.
- It is never HTML, markdown, a link, or anything clickable.
- Bidirectional control characters are stripped or escaped for display.
- Invalid UTF-8 renders as replacement characters and never breaks the page.

This holds on the bill page, both dashboards, the Memo data the app writes, and any indexer output. The contract enforces the 140-byte cap, counted in bytes.

**C15.** The payee address and amount the payer sees on the bill page are decoded, by the same code, from the same bytes the transaction will use: the on-chain record, or the verified signed bill.
- Amounts stay integers in base units end to end, and are formatted for display with the token's decimals.
- A decimal typed into a form is parsed once, at creation, and never re-parsed.
- Addresses are shown in full and checksummed.

**C16.** Payment status, and "paid by which transaction", come only from Adag's own storage or Adag's own event. The event is filtered by Adag's address and event signature, and tied to a transaction hash and log index. Memo events, GraphQL figures, and indexer rows that cannot be traced to an Adag event are decoration, never proof.
Amended 6 October (C72): the event must also carry the bill's own id and the connected account as payer. Other code runs in a conversion's transaction, so a genuine BillPaid for a different bill is not this payment.

**C17.** Every value Adag emits in an event (id, payee, currency, amount, payer) has already passed C7, C8 and C10. A downstream consumer acting on the event cannot be fed a value the contract did not accept.

### Upstream data

**C18.** Values from the public RPC, Morpho's GraphQL, an indexer or a swap quote are used only to display and to propose a pledge size. None is ever placed into a transaction as an address, selector, chain id or receiver. A wrong upstream value can cause a revert (C10, C1), never a loss.
Amended 6 October (C65 to C68): one scoped exception. Circle's swap plan is upstream calldata that does reach a batch. It is written into the batch only by the app's own encoder from typed fields, after the decoded plan has passed C66 and the re-encoded bytes have matched. What bounds the parts of it that Adag cannot read is C67 and C68, not trust in Circle.

**C19.** Every upstream fetch has an explicit timeout and a response size cap. Log queries are paged within the RPC's 10,000-block window, with a bounded page count. A failed or malformed response renders as "unavailable", never as zero, unpaid or paid.

### Batch and limits

**C20.** Any single failure inside a batch reverts the whole batch, so no bill in a batch can end up paid while another in the same batch is not.
Decided at the gate (25 September): there is no on-chain batch function. A multi-bill payment is several Memo-wrapped `pay` calls in one Multicall3From batch, every call with allowFailure false. Each bill keeps its own memo, and the batch is all or nothing. The app caps the bill count per batch, sized against the 30M block gas limit.
Amended 6 October (C71): a batch that converts has a fixed gas ceiling that includes the swap. A conversion that would need more, with 25% headroom over the simulated gas, is refused with a plain sentence. A batch holds at most one conversion. Amended 7 October: the ceiling is 4,000,000, raised from 2,500,000 because Circle's route for a bill of 1 to 3 USDC measured 1.9 to 2.4 million gas.

### Fee sponsor (only if built)

**C21.** The sponsor's hot wallet submits only transactions it decoded itself: a call to Adag or Multicall3From carrying a valid, unpaid bill, for which it holds the payer's signed authorization.
- It simulates before sending, and takes its fee in the same transaction.
- Each authorization binds the bill id, payee, currency, amount, the sponsor's address and a deadline, and can be used once.
- Per-address and global rate limits cap the sponsor's worst-hour loss at a written number of USDC.
- The payer's tokens can move only to the bill's payee and to the sponsor's fee address, in the amounts signed.

**C22.** Under EIP-7702, the delegation the app asks a payer to sign points only to an implementation fixed at build time, whose code cannot move funds except as C2 allows. The app never requests a delegation to an address from a URL or an upstream response. Before this path is offered, a fork test verifies whether a delegated account still counts as a plain wallet for Arc's CallFrom.

### Admin (only if built)

**C23.** No owner-settable value can redirect funds, mark a bill paid, change an existing bill's payee or currency, or weaken the limit for a payment already in flight. Owner changes emit an event and take effect after a delay long enough for payers to see them.
Choice: with no admin this holds by having nothing to set. An owner makes C10, C12 and C23 depend on storage, and adds a key to steal.

### General standards

1. **Primitives over lists.**
   - **Currency validity** means "equals the loan token of one of the two fixed market ids, as returned by Morpho", not a hand-kept token list. Covers fake tokens, cirBTC as a currency, and tokens added later. Does not cover an issuer upgrading a real token's behaviour.
   - **Signature validity** means the standard library's strict recovery, which rejects address zero, high s values and wrong lengths. Covers malleability and garbage signatures. Does not cover a payee whose key is stolen.
   - **Reference validity** means byte length, enforced on chain. Covers oversize. Does not cover meaning: phishing text is valid bytes, and C14 handles display.
   - **Address display** uses the library checksum. Covers transcription errors. Does not cover look-alike addresses with vanity prefixes.
   - **Target validity** in the builder means "equals one of the build-time constants". This is a list by nature, but a list of our own deployments, not of the world. It is tested by asserting that no other address can appear in the calldata the app builds.
2. **Normalize before you compare.**
   - The bill id comes from one encoding owned by the contract. The UI recomputes it with the same encoding and checks equality before showing it (C5).
   - Amounts are integers in base units from creation to event. Display only formats; it never parses (C15).
   - The payee shown is decoded from the same bytes the contract hashes (C15).
   - The loan check compares debt and collateral value in the same units, after the same conversions. The UI's preview uses the same formula as the contract, read from the contract where possible (C10, C13).
3. **Validate outputs like inputs.** Events (C17), Memo data (C14), links the app generates (C3, C5) and indexer rows (C16) are each treated as live input to whatever reads them next.
4. **Fail closed.**
   - Unreadable state reverts (C11).
   - A chain mismatch means no transaction (C4).
   - Batches have a cap and revert whole (C20).
   - Approvals are exact, and go to two spenders only (C3). A conversion adds one more, Circle's swap adapter, for the exact amount sold and set back to 0 in the same batch (C67).
   - allowFailure is always false (C3).
   - An upstream failure renders "unavailable" (C19).
   - A void beats a pay (C9).
   - Reads and pages are bounded (C19).
5. **Named non-goals.** Adag does not defend against:
   - **The identity of a payee.** A bill from an attacker who claims to be your landlord is a valid bill. Adag shows exactly who and how much; judging the who is the payer's job.
   - **Morpho, the oracles or the token contracts being wrong,** paused, blocklisting or upgraded. Adag fails closed on their reverts and zeros, nothing more.
   - **A compromised wallet, browser or operating system.**
   - **A compromised page build or hosting.** Pinned dependencies, a strict content security policy, no third-party scripts and no runtime-loaded code reduce the odds; they do not remove them. A payer signing a Multicall3From blob cannot detect a compromised page.
   - **Watching the position after payment.** Interest accrues, prices move, and Morpho liquidates at 86%. Adag checks the line once, at payment, and never again.
   - **A payer who goes above 40% by using Morpho directly.** Adag's line applies to payments made through Adag.
   - **Privacy.** Every bill, amount, reference and payer is public on chain and in every link.
   - **Front-running or MEV on a conversion.** Adag's payments in the bill's own currency have no slippage to extract. A conversion does: the buffer borrowed on top of the bill can be taken by someone who moves the swap's price before it lands. Adag bounds the loss and does not prevent it. The buffer is at most 1.5% above the bill's worth (`MAX_BUFFER_BPS` is 150, C70), the swap must still return at least the bill (C66), and the balance check fails the whole batch if it does not (C68). MEV rules on Arc were not measured.
   - **Availability** of the public RPC or Vercel.
   - **How third-party explorers render Memo data.**
   - **Enforcing due dates.** The due date is information unless a later decision makes it a rule.

---

## Notes on the review's open questions (25 September)

The review listed four facts to confirm. Status:
1. **USDC decimals.** Confirmed: native USDC uses 18 decimals and the ERC-20 interface uses 6, over one balance. Arc's docs say so, and our deploy wallet reads 5 on both views (block 22,705,889). Adag only ever uses the 6-decimal token interface.
2. **Morpho borrowing through Arc's batching.** Confirmed in a mainnet simulation. Borrowing with the payer as onBehalf works through Multicall3From and Memo without a separate Morpho authorization, because the sender Morpho sees is the payer.
3. **Transient storage.** Arc runs the Osaka baseline, which includes transient storage. Only relevant if the loan goes straight to the payee. To be confirmed by a fork test if that option is picked.
4. **EIP-7702-delegated wallets and Arc's batching.** Tested on a mainnet fork: a wallet upgraded under EIP-7702 can pay through Multicall3From and Memo as long as it sends its own transaction. Sponsored or relayed transactions still cannot.
