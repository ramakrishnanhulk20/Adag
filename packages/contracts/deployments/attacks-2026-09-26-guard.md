# AdagGuard attack runs, 2026-09-26

Each run tries to break AdagGuard with `node packages/contracts/prove-it/guard-attack.mjs`. Every attack is
simulated with eth_simulateV1 from a real mainnet block against the demo payer's real Morpho loan. Nothing
is signed or sent. Before the deploy, AdagGuard's runtime code is injected at its predicted address. State
overrides only fund a simulated stranger; G8 and G9 alone swap in a mock oracle, labelled as a simulated
price crash to zero.

## Run at block 22858500

Block 22858500 (2026-09-26T12:32:33.000Z), dRPC eth_simulateV1. AdagGuard is not deployed yet, so its runtime code from out-guard/AdagGuard.sol is injected at 0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806: deployer 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE is at nonce 3, and nonce 3 goes to AdagBills with enrol (not yet in arc-mainnet.json), so AdagGuard takes nonce 4.

Payer 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE: loan 1.000004 USDC against 0.00003133 cirBTC pledged, loan-to-value 37.89%; wallet 4.898352 USDC. BTC price 84,247.14 USDC per cirBTC. Simulated stranger 0x646b64C8ACAeb49e7FFa931354d47C9b00539229.

Unless a row says otherwise the payer's rule is: act at 35%, bring the loan back to 30%, no expiry.

| # | Attack | What should stop it | Actual | Result |
|---|---|---|---|---|
| G6 | Protect three times at the same price: twice in one block, once in the next | each protect repays only what brings the loan back to the target, so a repeat finds nothing to do (C38 as amended) | repaid 0.208166 USDC, then 0.000000 USDC, then 0.000000 USDC | PASS |
| G1 | Pull above the approval: the loan needs about 0.208166 USDC but the payer approved only 0.100000 USDC; protect twice | the approval is the lifetime ceiling (C38 as amended); protect caps at the allowance (C36) | first protect repaid 0.100000 USDC, pulled 0.100000 USDC, approval left 0.000000 USDC; second protect repaid 0.000000 USDC; guard holds 0.000000 USDC | PASS |
| G2a | protect the payer's loan through the other real USDC/cirBTC market on Morpho (same tokens, different oracle and rate model) | AdagGuard accepts only its two fixed market ids and checks their params on Morpho (C35, C41) | BadMarket(OTHER_MARKET) | PASS |
| G2b | Set a rule, then call protect, with a look-alike id one hex digit away from MARKET_USDC | same fixed-id check: a near miss is a different id | setRule: BadMarket(LOOK_ALIKE); protect: BadMarket(LOOK_ALIKE) | PASS |
| G2c | protect the payer in the EURC market, where they hold a USDC approval but have no loan and no rule | each market repays only in its own loan token, and only a real, triggered rule acts (C35, C36) | repaid 0.000000 USDC; payer USDC moved 0.000000 USDC | PASS |
| G3 | A stranger calls protect while the loan (37.89%) is under the payer's 50% trigger | protect acts only at or above the trigger; otherwise nothing moves and nothing is emitted (C36) | quote would act false (0.000000 USDC); protect repaid 0.000000 USDC, event none | PASS |
| G4 | The payer's rule expires 60 seconds after it is set; a stranger calls protect at the expiry second | an expired rule is inert (C41) | before expiry quote would act true (0.208166 USDC); at expiry quote would act false, protect repaid 0.000000 USDC | PASS |
| G5a | A stranger clears the payer's rule | rules are keyed by the sender; nobody can name another wallet (C34) | NoRule(0x646b64C8ACAeb49e7FFa931354d47C9b00539229, MARKET_USDC); payer's rule still 35.00% / 30.00% | PASS |
| G5b | A stranger sets a rule (80% / 1%) hoping it lands on the payer | same: setRule writes only the sender's own rule (C34) | success; payer's rule still 35.00% / 30.00%; the stranger's own rule is 80.00% / 1.00% | PASS |
| G7 | The payer's wallet holds only 0.050000 USDC when the loan needs about 0.208166 USDC | protect never pulls more than the wallet holds, and does not revert (C36) | repaid 0.050000 USDC; wallet now 0.000000 USDC; guard holds 0.000000 USDC | PASS |
| G8 | SIMULATED PRICE CRASH TO ZERO (mock oracle): protect with a 2 USDC approval against a 1.000004 USDC loan | the repay is capped at the debt rounded down, so Morpho's share maths cannot underflow; no revert (C36, C37) | quote true at no collateral, 1.000003 USDC; protect repaid 1.000003 USDC against a rounded-down debt of 1.000003 USDC; debt left 0.000001 USDC; guard holds 0.000000 USDC | PASS |
| G9a | SIMULATED PRICE CRASH TO ZERO: protect a payer who approved 1 USDC but never set a rule | no rule, no action, even at a zero price (C36, C41) | quote would act false at no collateral (0.000000 USDC); protect repaid 0.000000 USDC; payer USDC moved 0.000000 USDC | PASS |
| G9b | protect a wallet with no loan and no rule (0xa958eCC5F1BA5D373Af0Ee27406146892a453C75) | nothing to repay, nothing moves (C36) | repaid 0.000000 USDC; quote would act false | PASS |
| G10 | Call admin functions a drain would need: transferOwnership(address), withdraw(address,uint256), rescue(address,address,uint256), pause(), upgradeToAndCall(address,bytes) | no owner, pause, rescue or upgrade exists; only setRule, clearRule and protect change state (C39) | state-changing functions: clearRule, protect, setRule; fallback or receive: none; admin calls: all reverted | PASS |

All 14 checks behaved as the threat model says: nothing was pulled beyond the approval, the balance, the rounded-down debt or the target, and every refusal named the right reason.

## Run at block 22863638

Block 22863638 (2026-09-26T13:16:00.000Z), dRPC eth_simulateV1. AdagGuard at 0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806 (from D:\Projects\Arc-Fresh\packages\contracts\deployments\adag-guard.arc-mainnet.json).

Payer 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE: loan 1.000004 USDC against 0.00003133 cirBTC pledged, loan-to-value 37.89%; wallet 4.818215 USDC. BTC price 84,247.14 USDC per cirBTC. Simulated stranger 0x646b64C8ACAeb49e7FFa931354d47C9b00539229.

Unless a row says otherwise the payer's rule is: act at 35%, bring the loan back to 30%, no expiry.

| # | Attack | What should stop it | Actual | Result |
|---|---|---|---|---|
| G6 | Protect three times at the same price: twice in one block, once in the next | each protect repays only what brings the loan back to the target, so a repeat finds nothing to do (C38 as amended) | repaid 0.208166 USDC, then 0.000000 USDC, then 0.000000 USDC | PASS |
| G1 | Pull above the approval: the loan needs about 0.208166 USDC but the payer approved only 0.100000 USDC; protect twice | the approval is the lifetime ceiling (C38 as amended); protect caps at the allowance (C36) | first protect repaid 0.100000 USDC, pulled 0.100000 USDC, approval left 0.000000 USDC; second protect repaid 0.000000 USDC; guard holds 0.000000 USDC | PASS |
| G2a | protect the payer's loan through the other real USDC/cirBTC market on Morpho (same tokens, different oracle and rate model) | AdagGuard accepts only its two fixed market ids and checks their params on Morpho (C35, C41) | BadMarket(OTHER_MARKET) | PASS |
| G2b | Set a rule, then call protect, with a look-alike id one hex digit away from MARKET_USDC | same fixed-id check: a near miss is a different id | setRule: BadMarket(LOOK_ALIKE); protect: BadMarket(LOOK_ALIKE) | PASS |
| G2c | protect the payer in the EURC market, where they hold a USDC approval but have no loan and no rule | each market repays only in its own loan token, and only a real, triggered rule acts (C35, C36) | repaid 0.000000 USDC; payer USDC moved 0.000000 USDC | PASS |
| G3 | A stranger calls protect while the loan (37.89%) is under the payer's 50% trigger | protect acts only at or above the trigger; otherwise nothing moves and nothing is emitted (C36) | quote would act false (0.000000 USDC); protect repaid 0.000000 USDC, event none | PASS |
| G4 | The payer's rule expires 60 seconds after it is set; a stranger calls protect at the expiry second | an expired rule is inert (C41) | before expiry quote would act true (0.208166 USDC); at expiry quote would act false, protect repaid 0.000000 USDC | PASS |
| G5a | A stranger clears the payer's rule | rules are keyed by the sender; nobody can name another wallet (C34) | NoRule(0x646b64C8ACAeb49e7FFa931354d47C9b00539229, MARKET_USDC); payer's rule still 35.00% / 30.00% | PASS |
| G5b | A stranger sets a rule (80% / 1%) hoping it lands on the payer | same: setRule writes only the sender's own rule (C34) | success; payer's rule still 35.00% / 30.00%; the stranger's own rule is 80.00% / 1.00% | PASS |
| G7 | The payer's wallet holds only 0.050000 USDC when the loan needs about 0.208166 USDC | protect never pulls more than the wallet holds, and does not revert (C36) | repaid 0.050000 USDC; wallet now 0.000000 USDC; guard holds 0.000000 USDC | PASS |
| G8 | SIMULATED PRICE CRASH TO ZERO (mock oracle): protect with a 2 USDC approval against a 1.000004 USDC loan | the repay is capped at the debt rounded down, so Morpho's share maths cannot underflow; no revert (C36, C37) | quote true at no collateral, 1.000003 USDC; protect repaid 1.000003 USDC against a rounded-down debt of 1.000003 USDC; debt left 0.000001 USDC; guard holds 0.000000 USDC | PASS |
| G9a | SIMULATED PRICE CRASH TO ZERO: protect a payer who approved 1 USDC but never set a rule | no rule, no action, even at a zero price (C36, C41) | quote would act false at no collateral (0.000000 USDC); protect repaid 0.000000 USDC; payer USDC moved 0.000000 USDC | PASS |
| G9b | protect a wallet with no loan and no rule (0xa958eCC5F1BA5D373Af0Ee27406146892a453C75) | nothing to repay, nothing moves (C36) | repaid 0.000000 USDC; quote would act false | PASS |
| G10 | Call admin functions a drain would need: transferOwnership(address), withdraw(address,uint256), rescue(address,address,uint256), pause(), upgradeToAndCall(address,bytes) | no owner, pause, rescue or upgrade exists; only setRule, clearRule and protect change state (C39) | state-changing functions: clearRule, protect, setRule; fallback or receive: none; admin calls: all reverted | PASS |

All 14 checks behaved as the threat model says: nothing was pulled beyond the approval, the balance, the rounded-down debt or the target, and every refusal named the right reason.
