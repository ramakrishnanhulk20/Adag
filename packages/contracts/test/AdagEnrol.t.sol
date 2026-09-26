// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Fork tests for enrol on Arc mainnet: what it records and emits, that it touches only the caller's own record and
// moves no tokens, the same-block refusal in pay (C32), the two-block path the threat model names as a residual, and
// that new debt, the reused-shares bypass and first contact are still checked after or without an enrolment.
// Not covered here: random sequences of enrolments, borrows, repays and payments (AdagFuzz.t.sol and invariant/),
// enrolling from a Safe or any contract wallet, and real signed transactions. Results follow mainnet state at the
// block run-tests.sh pins: the demo wallet must hold 0.00011 cirBTC, 4 USDC and no Morpho debt there.

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../src/AdagBills.sol";
import {AdagFixture} from "./utils/AdagFixture.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {IMulticall3From} from "./utils/ArcInterfaces.sol";

contract AdagEnrolTest is AdagFixture {
    address internal constant PAYEE = address(0x5A11E5);
    address internal constant PAYEE_B = address(0x5A11E6);
    address internal constant ATTACKER = address(0xBAD5E7);
    uint256 internal constant COLLATERAL = 10_000;
    uint256 internal constant SMALL = 0.1e6;
    bytes internal constant REF = "INV-8812";

    bytes32 internal constant MARKET_USDC = ArcMainnet.MARKET_USDC;
    bytes32 internal constant MARKET_EURC = ArcMainnet.MARKET_EURC;

    function setUp() public override {
        super.setUp();
        assertGe(CIRBTC.balanceOf(PAYER), 11_000, "demo wallet holds under 0.00011 cirBTC");
        assertGe(USDC.balanceOf(PAYER), 4e6, "demo wallet holds under 4 USDC");
        assertEq(_liveShares(PAYER, MARKET_USDC), 0, "demo wallet already borrows USDC");
        assertEq(_liveShares(PAYER, MARKET_EURC), 0, "demo wallet already borrows EURC");
    }

    function test_enrol_recordsMorphoValuesAndEmitsThem() public {
        borrowDirect(PAYER, MARKET_USDC, 6_000, borrowForLtv(MARKET_USDC, 6_000, 0.5e18));
        borrowDirect(PAYER, MARKET_EURC, 4_000, borrowForLtv(MARKET_EURC, 4_000, 0.3e18));
        (, uint128 usdcShares, uint128 usdcCollateral) = MORPHO.position(MARKET_USDC, PAYER);
        (, uint128 eurcShares, uint128 eurcCollateral) = MORPHO.position(MARKET_EURC, PAYER);
        assertGt(usdcShares, 0);
        assertGt(eurcShares, 0);

        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.Enrolled(PAYER, usdcShares, usdcCollateral, eurcShares, eurcCollateral);
        vm.prank(PAYER);
        adag.enrol();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The expected event above is itself recorded, from this test contract, so it is left out of the count.
        uint256 emitted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(this)) emitted++;
        }
        assertEq(emitted, 1, "enrol emitted something besides Enrolled");
        (uint256 shares, uint256 collateral) = adag.seenPosition(PAYER, MARKET_USDC);
        assertEq(shares, usdcShares, "USDC shares");
        assertEq(collateral, usdcCollateral, "USDC collateral");
        (shares, collateral) = adag.seenPosition(PAYER, MARKET_EURC);
        assertEq(shares, eurcShares, "EURC shares");
        assertEq(collateral, eurcCollateral, "EURC collateral");
        assertEq(adag.enrolledAt(PAYER), block.number);
    }

    function test_enrol_byAttackerChangesNoOtherRecord() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.3e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        (uint256 payerUsdcShares, uint256 payerUsdcCollateral) = adag.seenPosition(PAYER, MARKET_USDC);
        (uint256 payerEurcShares, uint256 payerEurcCollateral) = adag.seenPosition(PAYER, MARKET_EURC);
        assertGt(payerUsdcShares, 0);

        deal(ArcMainnet.CIRBTC, ATTACKER, 20_000);
        borrowDirect(ATTACKER, MARKET_USDC, 20_000, borrowForLtv(MARKET_USDC, 20_000, 0.7e18));
        (, uint128 attackerShares, uint128 attackerCollateral) = MORPHO.position(MARKET_USDC, ATTACKER);

        vm.prank(ATTACKER);
        adag.enrol();

        (uint256 shares, uint256 collateral) = adag.seenPosition(PAYER, MARKET_USDC);
        assertEq(shares, payerUsdcShares, "the payer's USDC shares changed");
        assertEq(collateral, payerUsdcCollateral, "the payer's USDC collateral changed");
        (shares, collateral) = adag.seenPosition(PAYER, MARKET_EURC);
        assertEq(shares, payerEurcShares, "the payer's EURC shares changed");
        assertEq(collateral, payerEurcCollateral, "the payer's EURC collateral changed");
        assertEq(adag.enrolledAt(PAYER), 0, "the payer's enrol block changed");
        (shares, collateral) = adag.seenPosition(ATTACKER, MARKET_USDC);
        assertEq(shares, attackerShares);
        assertEq(collateral, attackerCollateral);

        // Someone else's enrolment in this block does not stop the payer paying in it.
        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        payCash(PAYER, id);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
    }

    function test_enrol_movesNoTokens() public {
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.5e18));
        IERC20[3] memory tokens = [USDC, EURC, CIRBTC];
        address[3] memory holders = [PAYER, address(adag), ArcMainnet.MORPHO];
        uint256[9] memory balances;
        uint256[6] memory allowances;
        for (uint256 t; t < 3; ++t) {
            for (uint256 h; h < 3; ++h) {
                balances[t * 3 + h] = tokens[t].balanceOf(holders[h]);
            }
            allowances[t * 2] = tokens[t].allowance(PAYER, address(adag));
            allowances[t * 2 + 1] = tokens[t].allowance(PAYER, ArcMainnet.MORPHO);
        }

        vm.recordLogs();
        vm.prank(PAYER);
        adag.enrol();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "enrol emitted a transfer or approval");
        assertEq(logs[0].emitter, address(adag));
        assertEq(logs[0].topics[0], AdagBills.Enrolled.selector);
        for (uint256 t; t < 3; ++t) {
            for (uint256 h; h < 3; ++h) {
                assertEq(tokens[t].balanceOf(holders[h]), balances[t * 3 + h], "a balance moved");
            }
            assertEq(tokens[t].allowance(PAYER, address(adag)), allowances[t * 2], "an allowance to Adag moved");
            assertEq(tokens[t].allowance(PAYER, ArcMainnet.MORPHO), allowances[t * 2 + 1], "an allowance to Morpho moved");
        }
        assertAdagHoldsNothing();
    }

    function test_enrolThenPay_sameBatch_isRefused() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);

        (bool ok, bytes memory ret) = tryBatch(PAYER, concat(_enrolCall(), cashCalls(id)));

        assertFalse(ok, "enrol and pay in one batch went through");
        assertEq(adagError(ret), abi.encodeWithSelector(AdagBills.EnrolledThisBlock.selector));
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
        assertEq(adag.enrolledAt(PAYER), 0, "the undone batch left an enrolment");
        assertEq(USDC.balanceOf(PAYEE), 0);

        // The same refusal across two transactions in one block, then the next block pays.
        vm.prank(PAYER);
        adag.enrol();
        vm.expectRevert(AdagBills.EnrolledThisBlock.selector);
        vm.prank(PAYER);
        adag.pay(id);

        vm.roll(block.number + 1);
        payCash(PAYER, id);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
        assertEq(USDC.balanceOf(PAYEE), SMALL);
    }

    function test_borrowEnrolAndPay_oneBatch_isRefused() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.7e18);
        IMulticall3From.Call3[] memory calls =
            concat(concat(pledgeAndBorrowCalls(PAYER, MARKET_USDC, COLLATERAL, borrow), _enrolCall()), cashCalls(id));

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok, "borrowing to 70%, enrolling and paying in one batch went through");
        assertEq(adagError(ret), abi.encodeWithSelector(AdagBills.EnrolledThisBlock.selector));
        (, uint128 shares, uint128 collateral) = MORPHO.position(MARKET_USDC, PAYER);
        assertEq(shares, 0, "the borrow survived");
        assertEq(collateral, 0, "the pledge survived");
        assertEq(recordedShares(MARKET_USDC), 0);
        assertEq(adag.enrolledAt(PAYER), 0);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    /// @dev The residual C32 names: debt taken outside Adag, enrolled in block N, then a cash bill in block N+1.
    function test_above40_enrolThenCashPayNextBlock_isUnchecked() public {
        _borrowTo70();
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, cashCalls(id));
        assertFalse(ok, "control: a payer at 70% paid before enrolling");
        _assertLtvAboveLimit(ret);

        vm.prank(PAYER);
        adag.enrol();
        uint256 enrolBlock = block.number;
        vm.roll(block.number + 1);

        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillPaid(id, PAYER, PAYEE, ArcMainnet.USDC, SMALL, false);
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_debtRecordCount(logs), 0, "an unchanged enrolled position was recorded again");
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
        assertEq(USDC.balanceOf(PAYEE), SMALL);
        assertEq(adag.enrolledAt(PAYER), enrolBlock);
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.7e18, 0.001e18);
    }

    function test_enrolled_borrowMoreInPayingBatch_isRefused() public {
        _borrowTo70();
        vm.prank(PAYER);
        adag.enrol();
        (uint256 enrolledShares,) = adag.seenPosition(PAYER, MARKET_USDC);
        vm.roll(block.number + 1);

        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, concat(borrowCalls(PAYER, MARKET_USDC, SMALL), cashCalls(id)));

        assertFalse(ok, "new debt on an enrolled 70% loan went through");
        _assertLtvAboveLimit(ret);
        assertEq(recordedShares(MARKET_USDC), enrolledShares);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    /// @dev The backend-gate bypass against an enrolled position: close outside Adag, pledge 90% of the enrolled
    /// collateral and borrow back exactly the enrolled share count. About 78%, under Morpho's own 86%.
    function test_enrolled_sameSharesLessCollateral_isRefused() public {
        _borrowTo70();
        vm.prank(PAYER);
        adag.enrol();
        (uint256 enrolledShares, uint256 enrolledCollateral) = adag.seenPosition(PAYER, MARKET_USDC);
        vm.roll(block.number + 1);
        closeLoan(PAYER, MARKET_USDC);

        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = concat(
            concat(pledgeCalls(PAYER, MARKET_USDC, enrolledCollateral * 9 / 10), borrowSharesCalls(PAYER, MARKET_USDC, enrolledShares)),
            cashCalls(id)
        );

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok, "the enrolled share count on less collateral skipped the check");
        _assertLtvAboveLimit(ret);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    function test_neverEnrolled_firstContactIsChecked() public {
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.6e18));
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);

        (bool ok, bytes memory ret) = tryBatch(PAYER, cashCalls(id));
        assertFalse(ok, "a payer at 60% who never enrolled paid");
        _assertLtvAboveLimit(ret);

        repayShares(PAYER, MARKET_USDC, _liveShares(PAYER, MARKET_USDC) / 2);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillPaid(id, PAYER, PAYEE, ArcMainnet.USDC, SMALL, true);
        runBatch(PAYER, calls);

        assertEq(adag.enrolledAt(PAYER), 0);
        assertEq(recordedShares(MARKET_USDC), _liveShares(PAYER, MARKET_USDC));
    }

    /// @dev Enrolling with no loan records zeros over an older record, so any later debt counts as new.
    function test_enrol_withNoLoan_recordsZerosAndLaterDebtIsChecked() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.3e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        closeLoan(PAYER, MARKET_USDC);
        assertGt(recordedShares(MARKET_USDC), 0, "setup: the old record should still hold the loan");

        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.Enrolled(PAYER, 0, 0, 0, 0);
        vm.prank(PAYER);
        adag.enrol();
        assertEq(recordedShares(MARKET_USDC), 0);
        assertEq(recordedCollateral(MARKET_USDC), 0);

        vm.roll(block.number + 1);
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.6e18));
        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, cashCalls(id));
        assertFalse(ok, "debt taken after a zero enrolment was not checked");
        _assertLtvAboveLimit(ret);
    }

    function _borrowTo70() internal {
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.7e18));
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.7e18, 0.001e18);
    }

    function _enrolCall() internal view returns (IMulticall3From.Call3[] memory calls) {
        calls = new IMulticall3From.Call3[](1);
        calls[0] = call3(address(adag), abi.encodeCall(AdagBills.enrol, ()));
    }

    function _assertLtvAboveLimit(bytes memory ret) internal view {
        bytes memory err = adagError(ret);
        assertEq(bytes4(err), AdagBills.LtvAboveLimit.selector, "not LtvAboveLimit");
        (bytes32 failedMarket, uint256 borrowed, uint256 maxBorrow) =
            abi.decode(this.dropSelector(err), (bytes32, uint256, uint256));
        assertEq(failedMarket, MARKET_USDC, "refused in the wrong market");
        assertGt(borrowed, maxBorrow);
    }

    function _liveShares(address user, bytes32 marketId) internal view returns (uint256) {
        (, uint128 shares,) = MORPHO.position(marketId, user);
        return shares;
    }

    function _debtRecordCount(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.DebtRecorded.selector) n++;
        }
    }
}
