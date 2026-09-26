# AdagGuard live runs, 2026-09-26

Written by `node packages/contracts/prove-it/guard-prove.mjs --broadcast` and `--clear` after real transactions on
Arc mainnet. Every hash links to explorer.arc.io.

## Protect at block 22867226

AdagGuard 0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806. Payer 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE, stranger 0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B. Rule 35% / 30%, approval 1.000000 USDC.

```
  tx 1 setRule and approve (payer)    block 22867219, gas 180,883, cost 0.003799 USDC   https://explorer.arc.io/tx/0x80bb926d550fbf485931a6a8939d01d5157f6c45cfad0b78c549f25c3d861ceb
  tx 2 protect (stranger)             block 22867226, gas 211,485, cost 0.004441 USDC   https://explorer.arc.io/tx/0xb54f4242b994d30f62022ceb395122bc3a1a83ca63220a970c5448085b5c9880
  tx 3 protect again (stranger)       block 22867241, gas 112,339, cost 0.002359 USDC   https://explorer.arc.io/tx/0x60f9ad40a0b4ad6caacd71d81aed447b4e58c8f86a600f9f3e9271625b538a37
  Protected  borrower 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE, repaid 0.464348 USDC, loan-to-value 39.07% to 30.00%
  Morpho Repay  caller 0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806 (AdagGuard), on behalf of 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE, 0.464348 USDC, 464108090206 shares
  quote for the protect block: would act true, 0.464348 USDC
  payer USDC        4.806140 USDC before, 4.341792 USDC after (-0.464348 USDC)
  payer loan        2.000004 USDC before, 1.535656 USDC after; loan-to-value 39.07% to 30.00% (exactly 29.9999843715080089%, target 30.0000000000000000%)
  payer bitcoin     0.00011973 cirBTC before, 0.00011973 cirBTC after (wallet plus pledged), sold 0.00000000 cirBTC
  payer approval    1.000000 USDC to AdagGuard before, 0.535652 USDC after
  AdagGuard         holds 0.000000 USDC before and 0.000000 USDC after; its approval to Morpho 0.000000 USDC before and 0.000000 USDC after
  gas               0.010599 USDC paid in all

  PASS  each transaction succeeded, from the expected wallet to the expected fixed address
  PASS  the rule is stored as set, and RuleSet names the payer
  PASS  the approval to AdagGuard is exactly 1 USDC
  PASS  quote for the protect block says it would act, and by how much (0.464348 USDC)
  PASS  protect by the stranger repaid exactly what quote said
  PASS  the loan-to-value landed at or under 30% (30.00%), and Protected reports the same
  PASS  the pull equals the repay: payer USDC fell by the repay, Morpho took exactly that for the payer
  PASS  the payer's approval fell by exactly the repay
  PASS  AdagGuard's USDC balance and its approval to Morpho are unchanged
  PASS  bitcoin sold: 0 (wallet plus pledged is unchanged)
  PASS  a second protect at the same price repays 0, emits nothing and moves no USDC
```

PROVEN on Arc mainnet: a second wallet's protect repaid 0.464348 USDC of the payer's own loan from the payer's own wallet, taking it from 39.07% to 30.00%, and no bitcoin was sold.
