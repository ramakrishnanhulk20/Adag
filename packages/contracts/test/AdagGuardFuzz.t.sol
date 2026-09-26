// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Fuzz tests for AdagGuard on an Arc mainnet fork: random loan sizes and loan-to-values, rules, time passing,
// prices (including a crash to zero), allowances and wallet balances, in both markets. Each run checks the money
// path (C35), the amount bounds (C36) and that quote equals protect in the same block (C40). The second contract
// measures each main action in its own transaction for analysis/GAS.md (run it with --isolate).
// Not covered here: random sequences of actions (test/invariant), liquidations, token pauses and blocklists, and
// real signed transactions. Prices move with vm.mockCall, not on chain.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagGuard} from "../src/AdagGuard.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {GuardFixture} from "./AdagGuard.t.sol";

contract AdagGuardFuzzTest is GuardFixture {
    address internal borrower = makeAddr("borrower");

    struct Input {
        bool eurc;
        uint256 collateral;
        uint256 startBps;
        uint256 trigger;
        uint256 target;
        uint256 warp;
        uint256 priceBps;
        uint256 allowance;
        uint256 balance;
        uint256 caller;
    }

    struct Before {
        uint256 ltv;
        uint256 debtUp;
        uint256 debtDown;
        uint256 wallet;
        uint256 allowance;
        uint256 guardBalance;
        uint256 collateral;
        uint256 price;
    }

    function testFuzz_protect_boundsIdentityAndQuote(Input memory input) public {
        bytes32 marketId = input.eurc ? MARKET_EURC : MARKET_USDC;
        IERC20 token = tokenOf(marketId);
        _arrange(marketId, input);

        (bool wouldAct, uint256 quoted, uint256 quotedLtv) = guard.quote(borrower, marketId);
        MORPHO.accrueInterest(paramsOf(marketId));
        Before memory b = _before(marketId, token);
        assertEq(quotedLtv, b.ltv, "quote's loan-to-value differs from Morpho's after accrual");

        uint256 snapshot = vm.snapshotState();
        vm.prank(makeAddr(string.concat("caller ", vm.toString(input.caller % 3))));
        uint256 repaid = guard.protect(borrower, marketId);

        assertEq(repaid, quoted, "protect differs from quote in the same block");
        assertEq(wouldAct, repaid > 0);
        assertEq(b.wallet - token.balanceOf(borrower), repaid, "pulled differs from repaid");
        assertEq(token.balanceOf(address(guard)), b.guardBalance, "guard balance changed");
        assertEq(token.allowance(address(guard), ArcMainnet.MORPHO), 0, "guard left an approval");
        if (b.allowance != type(uint256).max) {
            assertEq(token.allowance(borrower, address(guard)), b.allowance - repaid, "allowance spent wrongly");
        }

        assertLe(repaid, b.allowance, "over the allowance");
        assertLe(repaid, b.wallet, "over the balance");
        assertLe(repaid, b.debtDown, "over the debt rounded down");
        assertLe(debtUp(marketId, borrower), b.debtUp, "debt rose");
        (,, uint128 collateralAfter) = MORPHO.position(marketId, borrower);
        assertEq(collateralAfter, b.collateral, "collateral moved");

        uint256 ltvAfter = ltvOf(marketId, borrower);
        uint256 ceiling = input.target > b.ltv ? input.target : b.ltv;
        assertLe(ltvAfter, ceiling, "loan-to-value above max(target, before)");
        if (b.ltv < input.trigger) assertEq(repaid, 0, "acted under the trigger");
        if (b.ltv >= input.trigger && b.allowance > 0 && b.wallet > 0 && b.debtDown > 0) {
            assertGt(repaid, 0, "a triggered rule with room to pay did nothing");
        }

        bool capped = repaid == b.allowance || repaid == b.wallet || repaid == b.debtDown;
        if (repaid > 0 && !capped) {
            assertLe(ltvAfter, input.target, "uncapped repayment missed the target");
            _assertOneUnitLessMisses(snapshot, marketId, input.target, repaid, b.price);
        }
    }

    function testFuzz_setRule_acceptsOnlyValidRules(uint64 trigger, uint64 target, uint64 expiry, bool eurc) public {
        bytes32 marketId = eurc ? MARKET_EURC : MARKET_USDC;
        uint256 lltv = paramsOf(marketId).lltv;
        trigger = uint64(bound(trigger, 0, lltv + 1e17));
        target = uint64(bound(target, 0, lltv + 1e17));
        expiry = uint64(bound(expiry, 0, block.timestamp * 2));

        if (target == 0) {
            vm.expectRevert(AdagGuard.ZeroTarget.selector);
        } else if (target >= trigger) {
            vm.expectRevert(abi.encodeWithSelector(AdagGuard.TargetNotBelowTrigger.selector, target, trigger));
        } else if (trigger >= lltv) {
            vm.expectRevert(abi.encodeWithSelector(AdagGuard.TriggerNotBelowLiquidation.selector, trigger, lltv));
        } else if (expiry != 0 && expiry <= block.timestamp) {
            vm.expectRevert(abi.encodeWithSelector(AdagGuard.ExpiryInPast.selector, expiry));
        }
        vm.prank(borrower);
        guard.setRule(marketId, trigger, target, expiry);

        bool valid = target != 0 && target < trigger && trigger < lltv && (expiry == 0 || expiry > block.timestamp);
        AdagGuard.Rule memory r = guard.ruleOf(borrower, marketId);
        assertEq(r.triggerWad, valid ? trigger : 0);
        assertEq(r.targetWad, valid ? target : 0);
        assertEq(r.expiry, valid ? expiry : 0);
        assertEq(guard.holderCount(), valid ? 1 : 0);
    }

    function _arrange(bytes32 marketId, Input memory input) internal returns (uint256 borrowed) {
        uint256 lltv = paramsOf(marketId).lltv;
        input.collateral = bound(input.collateral, 1e4, 1e8);
        input.startBps = bound(input.startBps, 1000, 8000);
        input.trigger = bound(input.trigger, 2, lltv - 1);
        input.target = bound(input.target, 1, input.trigger - 1);
        input.warp = bound(input.warp, 0, 60 days);

        borrowed = openLoan(borrower, marketId, input.collateral, input.startBps * 1e14);
        setRule(borrower, marketId, input.trigger, input.target);
        vm.warp(block.timestamp + input.warp);
        // One run in sixteen crashes the price to zero, the case where only the debt cap stops a revert.
        uint256 price = input.priceBps % 16 == 0 ? 0 : oraclePrice(marketId) * bound(input.priceBps, 1000, 20_000) / 10_000;
        mockPrice(marketId, price);

        uint256 span = borrowed * 3 + 10;
        uint256 allowance = input.allowance % 5 == 0 ? type(uint256).max : bound(input.allowance, 0, span);
        approveGuard(borrower, marketId, allowance);
        setBalance(borrower, marketId, bound(input.balance, 0, span));
        input.allowance = allowance;
    }

    function _before(bytes32 marketId, IERC20 token) internal view returns (Before memory b) {
        b.ltv = ltvOf(marketId, borrower);
        b.debtUp = debtUp(marketId, borrower);
        b.debtDown = debtDown(marketId, borrower);
        b.wallet = token.balanceOf(borrower);
        b.allowance = token.allowance(borrower, address(guard));
        b.guardBalance = token.balanceOf(address(guard));
        (,, uint128 c) = MORPHO.position(marketId, borrower);
        b.collateral = c;
        b.price = oraclePrice(marketId);
    }

    // Back to the moment before protect: paying one unit less straight to Morpho leaves the loan above the target.
    function _assertOneUnitLessMisses(uint256 snapshot, bytes32 marketId, uint256 target, uint256 repaid, uint256 price)
        internal
    {
        vm.revertToState(snapshot);
        mockPrice(marketId, price);
        if (repaid == 1) return;
        setBalance(address(this), marketId, repaid);
        tokenOf(marketId).approve(ArcMainnet.MORPHO, repaid);
        MORPHO.repay(paramsOf(marketId), repaid - 1, 0, borrower, "");
        assertGt(ltvOf(marketId, borrower), target, "one unit less would also have reached the target");
    }
}

// One test per action. Run with --isolate so each top-level call is its own cold transaction, then read the gas
// of the measured call from the -vvvv trace.
contract AdagGuardGasScenarios is GuardFixture {
    address internal borrower = makeAddr("borrower");
    address internal keeper = makeAddr("keeper");

    function test_gas_setRule_first() public {
        vm.prank(borrower);
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, 0);
    }

    function test_gas_clearRule_last() public {
        vm.prank(borrower);
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, 0);
        vm.prank(borrower);
        guard.clearRule(MARKET_USDC);
    }

    function test_gas_protect_acting() public {
        openLoan(borrower, MARKET_USDC, COLLATERAL, 0.5e18);
        setRule(borrower, MARKET_USDC, 0.7e18, 0.6e18);
        approveGuard(borrower, MARKET_USDC, 1_000_000e6);
        moveToLtv(borrower, MARKET_USDC, 0.75e18);
        // A minute later, so protect pays for Morpho's interest step as a real keeper call would.
        vm.warp(block.timestamp + 60);
        vm.prank(keeper);
        guard.protect(borrower, MARKET_USDC);
    }

    function test_gas_protect_noop() public {
        openLoan(borrower, MARKET_USDC, COLLATERAL, 0.5e18);
        setRule(borrower, MARKET_USDC, 0.7e18, 0.6e18);
        approveGuard(borrower, MARKET_USDC, 1_000_000e6);
        vm.warp(block.timestamp + 60);
        vm.prank(keeper);
        guard.protect(borrower, MARKET_USDC);
    }
}
