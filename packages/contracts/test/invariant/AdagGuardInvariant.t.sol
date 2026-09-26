// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Invariant tests for AdagGuard on an Arc mainnet fork. AdagGuardHandler runs random sequences of rules, approvals,
// Morpho borrowing and repaying, price moves (zero included), time passing and protect calls from six callers,
// and these five rules must hold after every step. The second contract is the negative control: the same handler
// against a guard with the rounded-down debt cap removed, where the handler must report a break.
// Not covered here: liquidations, token pauses and blocklists, more than three borrowers, and real signed
// transactions. Borrowers are funded with deal(): 10,000 USDC and 10,000 EURC each, plus cirBTC as they borrow.

import {AdagGuard} from "../../src/AdagGuard.sol";
import {ArcMainnet} from "../utils/ArcMainnet.sol";
import {GuardFixture} from "../AdagGuard.t.sol";
import {AdagGuardHandler} from "./AdagGuardHandler.sol";

// AdagGuard with the cap on the rounded-down debt removed. Used only by the negative control below.
contract AdagGuardNoDebtCap is AdagGuard {
    function _repayCap(Loan memory) internal pure override returns (uint256) {
        return type(uint256).max;
    }
}

abstract contract GuardInvariantBase is GuardFixture {
    AdagGuardHandler internal handler;

    function deployHandler(AdagGuard target) internal {
        address[3] memory borrowers = [makeAddr("borrower 1"), makeAddr("borrower 2"), makeAddr("borrower 3")];
        address[3] memory strangers = [makeAddr("stranger 1"), makeAddr("stranger 2"), makeAddr("stranger 3")];
        for (uint256 i; i < 3; ++i) {
            // Native USDC has 18 decimals; the ERC-20 face reads this as 10,000 USDC.
            vm.deal(borrowers[i], 10_000e18);
            deal(ArcMainnet.EURC, borrowers[i], 10_000e6);
        }
        handler = new AdagGuardHandler(target, borrowers, strangers);
    }
}

contract AdagGuardInvariantTest is GuardInvariantBase {
    function setUp() public override {
        super.setUp();
        deployHandler(guard);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = AdagGuardHandler.setRule.selector;
        selectors[1] = AdagGuardHandler.clearRule.selector;
        selectors[2] = AdagGuardHandler.approve.selector;
        selectors[3] = AdagGuardHandler.borrow.selector;
        selectors[4] = AdagGuardHandler.repay.selector;
        selectors[5] = AdagGuardHandler.movePrice.selector;
        selectors[6] = AdagGuardHandler.passTime.selector;
        selectors[7] = AdagGuardHandler.protect.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        // Left free, the fuzzer draws callers from addresses it finds in state, and Arc refuses any call from an
        // address on its native blocklist. The handler pranks the real actor.
        targetSender(makeAddr("fuzz caller"));
    }

    /// I1 (C35): the guard never holds a token or an approval to Morpho after a call.
    function invariant_I1_guardHoldsNothing() public view {
        assertGuardHoldsNothing();
        assertEq(handler.identityBreaks(), 0, handler.firstBreak());
    }

    /// I2 (C36, C38 as amended): no borrower ever loses more than they approved. Since each approval, the pulled
    /// total is at most that approval and the allowance left is exactly the rest.
    function invariant_I2_pulledNeverExceedsApproved() public view {
        for (uint256 i; i < 3; ++i) {
            address b = handler.borrowerAt(i);
            _checkApproval(b, address(USDC));
            _checkApproval(b, address(EURC));
        }
    }

    /// I3 (C34, C35): protect never raises anyone's debt.
    function invariant_I3_protectNeverRaisesDebt() public view {
        assertEq(handler.debtBreaks(), 0, handler.firstBreak());
    }

    /// I4 (C43): the holder set is exactly the addresses with at least one rule.
    function invariant_I4_holderSetMatchesRules() public view {
        assertEq(handler.ruleBreaks(), 0, handler.firstBreak());
        uint256 withRule;
        for (uint256 i; i < 6; ++i) {
            address who = i < 3 ? handler.borrowerAt(i) : handler.strangerAt(i - 3);
            bool hasUsdc = guard.ruleOf(who, MARKET_USDC).triggerWad != 0;
            bool hasEurc = guard.ruleOf(who, MARKET_EURC).triggerWad != 0;
            assertEq(hasUsdc, handler.ghostRule(who, MARKET_USDC), "USDC rule differs from the ghost");
            assertEq(hasEurc, handler.ghostRule(who, MARKET_EURC), "EURC rule differs from the ghost");
            if (hasUsdc || hasEurc) ++withRule;
        }
        assertEq(guard.holderCount(), withRule, "holder count differs from wallets with a rule");
        address[] memory listed = guard.holders(0, 100);
        assertEq(listed.length, withRule);
        for (uint256 i; i < listed.length; ++i) {
            bool has = guard.ruleOf(listed[i], MARKET_USDC).triggerWad != 0
                || guard.ruleOf(listed[i], MARKET_EURC).triggerWad != 0;
            assertTrue(has, "a listed holder has no rule");
        }
    }

    /// I5 (C36): protect never reverts on a real position, even when the price is zero.
    function invariant_I5_protectNeverReverts() public view {
        assertEq(handler.revertBreaks(), 0, handler.firstBreak());
    }

    function _checkApproval(address b, address token) internal view {
        uint256 approved = handler.lastApproved(b, token);
        uint256 pulled = handler.pulledSinceApproval(b, token);
        if (approved != type(uint256).max) {
            assertLe(pulled, approved, "pulled more than the approval");
            assertEq(_allowance(b, token), approved - pulled, "allowance left is not approval minus pulled");
        }
        if (!handler.everUnlimited(b, token)) {
            assertLe(handler.totalPulled(b, token), handler.totalApproved(b, token), "pulled more than ever approved");
        }
    }

    function _allowance(address b, address token) internal view returns (uint256) {
        return token == address(USDC) ? USDC.allowance(b, address(guard)) : EURC.allowance(b, address(guard));
    }
}

contract AdagGuardNegativeControlTest is GuardInvariantBase {
    // A 50% loan with a rule and a full approval, then the price goes to zero and a stranger calls protect.
    function _crashAndProtect() internal {
        handler.borrow(0, false, 1e6, 5000);
        handler.setRule(0, false, 7000, 6000, 1);
        handler.approve(0, false, 7);
        handler.movePrice(false, 0);
        handler.protect(0, 0, false);
    }

    function test_realGuard_survivesTheCrash() public {
        deployHandler(guard);
        _crashAndProtect();
        assertEq(handler.revertBreaks(), 0, handler.firstBreak());
        assertEq(handler.zeroPriceActs(), 1, "the real guard did not repay at zero price");
    }

    function test_withoutTheDebtCap_theHandlerReportsABreak() public {
        deployHandler(new AdagGuardNoDebtCap());
        _crashAndProtect();
        assertEq(handler.revertBreaks(), 1, "removing the debt cap went unnoticed");
        // Morpho's arithmetic underflow when the repayment burns more shares than the borrower holds.
        assertEq(
            handler.firstBreak(),
            string.concat("protect reverted: ", vm.toString(abi.encodeWithSignature("Panic(uint256)", 0x11)))
        );
    }
}
