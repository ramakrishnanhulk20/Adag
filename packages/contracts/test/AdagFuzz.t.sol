// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Fuzz tests for AdagBills on an Arc mainnet fork: bill input validation, the 40% line against an independent
// restatement of Morpho's maths, the collateral preview, loanToValue, price drops after a loan, and enrolments at
// random moments between borrows, repays and payments (C32). The second contract measures each main action in its
// own transaction for analysis/GAS.md (run it with --isolate).
// Not covered here: random sequences across bills, payers and prices (test/invariant), the EURC market in the
// price-drop, collateral and enrolment cases, fee-on-transfer or blocklisted tokens, and real signed transactions.
// Prices are moved with vm.mockCall, not observed on chain. Results follow live mainnet state: the demo wallet must
// still hold 0.00011 cirBTC, 4 USDC and no Morpho debt.

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../src/AdagBills.sol";
import {IOracleMinimal} from "../src/interfaces/IOracleMinimal.sol";
import {AdagFixture} from "./utils/AdagFixture.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {IMemo, IMulticall3From} from "./utils/ArcInterfaces.sol";

contract AdagFuzzTest is AdagFixture {
    address internal constant PAYEE = address(0x5A11E5);
    address internal constant PAYEE_B = address(0x5A11E6);
    address internal constant PAYEE_C = address(0x5A11E7);
    uint256 internal constant COLLATERAL = 10_000;
    uint256 internal constant SMALL = 0.1e6;
    bytes internal constant REF = "PO-9001";
    bytes32 internal constant MARKET_USDC = ArcMainnet.MARKET_USDC;
    bytes32 internal constant MARKET_EURC = ArcMainnet.MARKET_EURC;

    function setUp() public override {
        super.setUp();
        assertGe(CIRBTC.balanceOf(PAYER), 11_000, "demo wallet holds under 0.00011 cirBTC");
        assertGe(USDC.balanceOf(PAYER), 4e6, "demo wallet holds under 4 USDC");
        (, uint128 usdcShares,) = MORPHO.position(MARKET_USDC, PAYER);
        (, uint128 eurcShares,) = MORPHO.position(MARKET_EURC, PAYER);
        assertEq(uint256(usdcShares) + eurcShares, 0, "demo wallet already borrows");
    }

    function testFuzz_createBill_storesOrRejects(uint256 amount, uint256 refLength, uint256 salt, bool eurc, uint64 due)
        public
    {
        amount = _bound(amount, 0, 1e15);
        refLength = _bound(refLength, 0, 200);
        bytes memory ref = _randomBytes(refLength, salt);
        address currency = eurc ? ArcMainnet.EURC : ArcMainnet.USDC;

        if (amount == 0) {
            vm.expectRevert(AdagBills.ZeroAmount.selector);
        } else if (refLength > 140) {
            vm.expectRevert(abi.encodeWithSelector(AdagBills.ReferenceTooLong.selector, refLength));
        }
        vm.prank(PAYEE);
        uint256 id = adag.createBill(currency, amount, due, ref);

        if (amount == 0 || refLength > 140) {
            assertEq(adag.billCount(), 0, "a refused bill was counted");
            return;
        }
        AdagBills.Bill memory b = adag.bill(id);
        assertEq(id, 1);
        assertEq(b.payee, PAYEE);
        assertEq(uint8(b.status), uint8(AdagBills.Status.Open));
        assertEq(b.due, due);
        assertEq(b.currency, currency);
        assertEq(b.createdAt, block.timestamp);
        assertEq(b.amount, amount);
        assertEq(b.payer, address(0));
        assertEq(b.paidAt, 0);
        assertEq(b.ref, ref);
    }

    function testFuzz_line_matchesIndependentMaths(uint256 ltvBps) public {
        ltvBps = _bound(ltvBps, 100, 8000);
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, ltvBps * 1e14);
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, borrow, REF);
        (uint256 debtAfter, uint256 newShares) = independentDebtAfterBorrow(MARKET_USDC, PAYER, borrow);
        bool withinLine = debtAfter <= independentLineFor(MARKET_USDC, COLLATERAL);
        uint256 cirBtcBefore = CIRBTC.balanceOf(PAYER);

        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, id, COLLATERAL, borrow));

        assertEq(ok, withinLine, "Adag and the independent maths disagree on the 40% line");
        (, uint128 shares, uint128 pledged) = MORPHO.position(MARKET_USDC, PAYER);
        if (ok) {
            assertEq(shares, newShares, "independent share maths is off");
            assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
            assertEq(USDC.balanceOf(PAYEE), borrow);
        } else {
            _assertLtvAboveLimit(ret, MARKET_USDC);
            assertEq(pledged, 0, "refused batch left collateral pledged");
            assertEq(CIRBTC.balanceOf(PAYER), cirBtcBefore);
            assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
            assertEq(USDC.balanceOf(PAYEE), 0);
        }
        assertAdagHoldsNothing();
    }

    function testFuzz_collateralNeeded_isTheSmallestThatPasses(uint256 existingBps, uint256 extra) public {
        // 0.01 cirBTC: the demo wallet's own 0.00011973 cannot back loans of this size.
        deal(ArcMainnet.CIRBTC, PAYER, 1e6);
        existingBps = _bound(existingBps, 0, 7000);
        extra = _bound(extra, 1e4, 200e6);
        uint256 base = 20_000;
        if (existingBps == 0) {
            runBatch(PAYER, pledgeCalls(PAYER, MARKET_USDC, base));
        } else {
            borrowDirect(PAYER, MARKET_USDC, base, borrowForLtv(MARKET_USDC, base, existingBps * 1e14));
        }
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        uint256 current = independentDebt(MARKET_USDC, PAYER);
        (uint256 debtAfter,) = independentDebtAfterBorrow(MARKET_USDC, PAYER, extra);
        // Morpho's share rounding can move the real debt a unit or two away from current + extra. The contract
        // is asked about the real figure; this bound is what an app's margin has to cover.
        assertApproxEqAbs(debtAfter, current + extra, 2, "rounding gap above 2 units");
        uint256 need = adag.collateralNeeded(PAYER, MARKET_USDC, debtAfter - current);
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, extra, REF);
        IMulticall3From.Call3[] memory tail = concat(borrowCalls(PAYER, MARKET_USDC, extra), cashCalls(id));

        if (need > 0) {
            (bool ok, bytes memory ret) = tryBatch(PAYER, _withPledge(need - 1, tail));
            assertFalse(ok, "one satoshi under the suggestion went through");
            _assertLtvAboveLimit(ret, MARKET_USDC);
        }
        runBatch(PAYER, _withPledge(need, tail));

        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
        assertLe(independentDebt(MARKET_USDC, PAYER), independentLine(MARKET_USDC, PAYER));
    }

    function testFuzz_loanToValue_matchesIndependentMaths(uint256 ltvBps, bool eurc) public {
        ltvBps = _bound(ltvBps, 100, 8000);
        bytes32 marketId = eurc ? MARKET_EURC : MARKET_USDC;
        borrowDirect(PAYER, marketId, COLLATERAL, borrowForLtv(marketId, COLLATERAL, ltvBps * 1e14));

        uint256 debt = independentDebt(marketId, PAYER);
        (,, uint128 collateral) = MORPHO.position(marketId, PAYER);
        uint256 value = uint256(collateral) * IOracleMinimal(paramsOf(marketId).oracle).price() / 1e36;
        uint256 expected = (debt * 1e18 + value - 1) / value;

        assertApproxEqAbs(adag.loanToValue(PAYER, marketId), expected, 1);
        assertApproxEqAbs(expected, ltvBps * 1e14, 0.001e18, "the input did not set the loan it meant to");
    }

    function testFuzz_priceDrop_cashAlwaysPasses_newDebtOnlyWithinLine(uint256 dropBps, uint256 newBorrow) public {
        dropBps = _bound(dropBps, 0, 6000);
        newBorrow = _bound(newBorrow, 1e4, 3e6);
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.35e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 price = IOracleMinimal(paramsOf(MARKET_USDC).oracle).price();
        mockPrice(MARKET_USDC, price * (10_000 - dropBps) / 10_000);

        uint256 cashId = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        runBatch(PAYER, cashCalls(cashId));
        assertEq(uint8(adag.bill(cashId).status), uint8(AdagBills.Status.Paid), "a price drop blocked cash");
        assertEq(USDC.balanceOf(PAYEE_B), SMALL);

        uint256 loanId = makeBill(PAYEE_C, ArcMainnet.USDC, newBorrow, REF);
        (uint256 debtAfter,) = independentDebtAfterBorrow(MARKET_USDC, PAYER, newBorrow);
        bool withinLine = debtAfter <= independentLine(MARKET_USDC, PAYER);
        (bool ok, bytes memory ret) =
            tryBatch(PAYER, concat(borrowCalls(PAYER, MARKET_USDC, newBorrow), cashCalls(loanId)));

        assertEq(ok, withinLine, "new debt after a price drop disagrees with the independent maths");
        if (!ok) {
            (,, uint128 collateral) = MORPHO.position(MARKET_USDC, PAYER);
            uint256 morphoLine = uint256(collateral) * IOracleMinimal(paramsOf(MARKET_USDC).oracle).price() / 1e36
                * 86 / 100;
            if (debtAfter <= morphoLine) {
                _assertLtvAboveLimit(ret, MARKET_USDC);
            } else {
                // Past Morpho's own 86% line, Morpho refuses the borrow before Adag's step runs.
                assertEq(ret, abi.encodeWithSignature("Error(string)", "insufficient collateral"));
            }
            assertEq(uint8(adag.bill(loanId).status), uint8(AdagBills.Status.Open));
        }
        assertAdagHoldsNothing();
    }

    /// @dev Each step is one of: borrow outside Adag, repay part, enrol, pay a cash bill, borrow and pay in one
    /// batch, or move to the next block. Every payment attempt is judged against C32.
    function testFuzz_enrolAtRandomMoments_holdsC32(uint8[8] calldata ops, uint256[8] calldata sizes) public {
        deal(ArcMainnet.CIRBTC, PAYER, 1e6);
        // Native USDC has 18 decimals; the ERC-20 face reads this as 1,000 USDC.
        vm.deal(PAYER, 1_000e18);
        for (uint256 i; i < ops.length; ++i) {
            uint256 op = ops[i] % 6;
            if (op == 0) {
                uint256 collateral = _bound(sizes[i], 1_000, 50_000);
                uint256 ltvBps = _bound(sizes[i] >> 128, 1_000, 7_500);
                uint256 borrow = borrowForLtv(MARKET_USDC, collateral, ltvBps * 1e14);
                if (borrow > 0) tryBatch(PAYER, pledgeAndBorrowCalls(PAYER, MARKET_USDC, collateral, borrow));
            } else if (op == 1) {
                (, uint128 shares,) = MORPHO.position(MARKET_USDC, PAYER);
                uint256 part = uint256(shares) * _bound(sizes[i], 1, 10_000) / 10_000;
                if (part > 0) tryBatch(PAYER, repaySharesCalls(PAYER, MARKET_USDC, part));
            } else if (op == 2) {
                vm.prank(PAYER);
                adag.enrol();
            } else if (op == 3) {
                uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
                _payAndJudge(cashCalls(id));
            } else if (op == 4) {
                uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
                _payAndJudge(concat(borrowCalls(PAYER, MARKET_USDC, _bound(sizes[i], 1e4, 2e6)), cashCalls(id)));
            } else {
                vm.roll(block.number + 1);
            }
        }
    }

    function _payAndJudge(IMulticall3From.Call3[] memory calls) internal {
        (uint256 seenShares, uint256 seenCollateral) = adag.seenPosition(PAYER, MARKET_USDC);
        bool enrolledThisBlock = adag.enrolledAt(PAYER) == block.number;

        vm.recordLogs();
        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // A borrow Morpho refuses stops the batch before Adag's step, so only a Memo failure carries Adag's error.
        bool adagRefused = !ok && bytes4(ret) == IMemo.MemoFailed.selector;
        if (enrolledThisBlock) {
            assertFalse(ok, "paid in the block of its own enrolment");
            if (adagRefused) assertEq(adagError(ret), abi.encodeWithSelector(AdagBills.EnrolledThisBlock.selector));
            return;
        }
        if (!ok) {
            if (adagRefused) _assertLtvAboveLimit(ret, MARKET_USDC);
            return;
        }
        (, uint128 shares, uint128 collateral) = MORPHO.position(MARKET_USDC, PAYER);
        bool riskier = shares != 0 && (shares > seenShares || collateral < seenCollateral);
        assertEq(_loanChecked(logs), riskier, "whether the check ran differs from C32");
        if (riskier) {
            assertLe(independentDebt(MARKET_USDC, PAYER), independentLine(MARKET_USDC, PAYER), "checked debt above 40%");
        }
    }

    function _loanChecked(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.BillPaid.selector) {
                (,, bool loanChecked) = abi.decode(logs[i].data, (address, uint256, bool));
                return loanChecked;
            }
        }
        revert("no BillPaid event");
    }

    function _withPledge(uint256 collateral, IMulticall3From.Call3[] memory tail)
        internal
        view
        returns (IMulticall3From.Call3[] memory)
    {
        // Morpho refuses a zero pledge, so a zero suggestion means no pledge step at all.
        if (collateral == 0) return tail;
        return concat(pledgeCalls(PAYER, MARKET_USDC, collateral), tail);
    }

    function _assertLtvAboveLimit(bytes memory ret, bytes32 marketId) internal view {
        bytes memory err = adagError(ret);
        assertEq(bytes4(err), AdagBills.LtvAboveLimit.selector, "not LtvAboveLimit");
        (bytes32 failedMarket,,) = abi.decode(this.dropSelector(err), (bytes32, uint256, uint256));
        assertEq(failedMarket, marketId, "refused in the wrong market");
    }

    function _randomBytes(uint256 length, uint256 salt) internal pure returns (bytes memory b) {
        b = new bytes(length);
        for (uint256 i; i < length; ++i) {
            b[i] = bytes1(uint8(uint256(keccak256(abi.encode(salt, i)))));
        }
    }
}

/// @dev Each main action as its own top-level call, so `--isolate` runs it as a separate transaction with cold
/// storage and the 21,000 base cost. Setup steps are separate calls and are not part of the measured one.
contract AdagGasScenarios is AdagFixture {
    address internal constant PAYEE = address(0x5A11E5);
    address internal constant PAYEE_B = address(0x5A11E6);
    address internal constant PAYEE_C = address(0x5A11E7);

    function test_gas_createBillShortReference() public {
        vm.prank(PAYEE);
        adag.createBill(ArcMainnet.USDC, 1e6, 0, "INV-2026-0042");
    }

    function test_gas_createBill140ByteReference() public {
        vm.prank(PAYEE);
        adag.createBill(ArcMainnet.USDC, 1e6, 0, bytes(string.concat(_repeat("0123456789", 14))));
    }

    function test_gas_voidBill() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, 1e6, "INV-1");
        vm.prank(PAYEE);
        adag.voidBill(id);
    }

    function test_gas_enrol() public {
        borrowDirect(PAYER, ArcMainnet.MARKET_USDC, 10_000, borrowForLtv(ArcMainnet.MARKET_USDC, 10_000, 0.6e18));
        vm.prank(PAYER);
        adag.enrol();
    }

    function test_gas_cashPayBatch() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, 1e6, "INV-1");
        runBatch(PAYER, cashCalls(id));
    }

    function test_gas_loanPayBatch() public {
        uint256 borrow = borrowForLtv(ArcMainnet.MARKET_USDC, 10_000, 0.3e18);
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, borrow, "INV-1");
        runBatch(PAYER, loanCalls(PAYER, id, 10_000, borrow));
    }

    function test_gas_threeBillBatch() public {
        uint256 usdcBorrow = borrowForLtv(ArcMainnet.MARKET_USDC, 6_000, 0.3e18);
        uint256 eurcBorrow = borrowForLtv(ArcMainnet.MARKET_EURC, 4_000, 0.3e18);
        uint256 id1 = makeBill(PAYEE, ArcMainnet.USDC, usdcBorrow / 2, "A-1");
        uint256 id2 = makeBill(PAYEE_B, ArcMainnet.USDC, usdcBorrow - usdcBorrow / 2, "B-2");
        uint256 id3 = makeBill(PAYEE_C, ArcMainnet.EURC, eurcBorrow, "C-3");
        IMulticall3From.Call3[] memory tail = new IMulticall3From.Call3[](5);
        tail[0] = call3(ArcMainnet.USDC, abi.encodeCall(IERC20.approve, (address(adag), usdcBorrow)));
        tail[1] = call3(ArcMainnet.EURC, abi.encodeCall(IERC20.approve, (address(adag), eurcBorrow)));
        tail[2] = memoPayCall(id1, "A-1");
        tail[3] = memoPayCall(id2, "B-2");
        tail[4] = memoPayCall(id3, "C-3");
        runBatch(
            PAYER,
            concat(
                concat(
                    pledgeAndBorrowCalls(PAYER, ArcMainnet.MARKET_USDC, 6_000, usdcBorrow),
                    pledgeAndBorrowCalls(PAYER, ArcMainnet.MARKET_EURC, 4_000, eurcBorrow)
                ),
                tail
            )
        );
    }

    function test_gas_fullCloseBatch() public {
        uint256 borrow = borrowForLtv(ArcMainnet.MARKET_USDC, 10_000, 0.3e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, "INV-1"), 10_000, borrow);
        vm.warp(block.timestamp + 1 hours);
        IMulticall3From.Call3[] memory calls = closeLoanCalls(PAYER, ArcMainnet.MARKET_USDC);
        runBatch(PAYER, calls);
        (, uint128 shares, uint128 collateral) = MORPHO.position(ArcMainnet.MARKET_USDC, PAYER);
        assertEq(uint256(shares) + collateral, 0, "close left a position");
    }

    function _repeat(string memory s, uint256 times) internal pure returns (string memory out) {
        for (uint256 i; i < times; ++i) {
            out = string.concat(out, s);
        }
    }
}
