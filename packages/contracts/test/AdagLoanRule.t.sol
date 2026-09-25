// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Fork tests for the 40% new-debt rule on Arc mainnet: loan-backed payments through Memo and Multicall3From, the
// line itself, price drops, borrowing around the check, reusing a recorded share count on less or more collateral,
// adding or withdrawing collateral outside Adag, stale and broken price feeds, a market Morpho reports wrongly, the
// oracles' feed layout, the collateral preview, the full loan close, three bills in one signature, and the
// residual the threat model accepts (C10).
// Not covered here: fuzz and invariant tests on the money maths and batch-size limits (WO-3), and real signed
// transactions. Price moves and feed failures are simulated with vm.mockCall, not observed on chain. Results
// follow live mainnet state: the demo wallet must still hold 0.00011 cirBTC, 4 USDC and no Morpho debt.

import {Vm} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../src/AdagBills.sol";
import {MarketParams} from "../src/interfaces/IMorphoMinimal.sol";
import {IOracleMinimal} from "../src/interfaces/IOracleMinimal.sol";
import {IChainlinkFeed} from "../src/interfaces/IChainlinkFeed.sol";
import {AdagFixture, IMorphoBorrow} from "./utils/AdagFixture.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {IMemo, IMulticall3From} from "./utils/ArcInterfaces.sol";

/// @dev The MorphoChainlinkOracleV2 getters that decide where its price comes from.
interface IOracleLayout {
    function BASE_VAULT() external view returns (address);
    function BASE_FEED_1() external view returns (address);
    function BASE_FEED_2() external view returns (address);
    function QUOTE_VAULT() external view returns (address);
    function QUOTE_FEED_1() external view returns (address);
    function QUOTE_FEED_2() external view returns (address);
}

contract AdagLoanRuleTest is AdagFixture {
    struct DebtRecord {
        bytes32 marketId;
        uint256 shares;
        uint256 collateral;
        bool checked;
    }

    address internal constant PAYEE = address(0x5A11E5);
    address internal constant PAYEE_B = address(0x5A11E6);
    address internal constant PAYEE_C = address(0x5A11E7);
    /// @dev 0.0001 cirBTC, about 8 dollars, leaving the rest of the demo wallet's 11,973 satoshis for top-ups.
    uint256 internal constant COLLATERAL = 10_000;
    uint256 internal constant SMALL = 0.1e6;
    bytes internal constant REF = "PO-7781";

    bytes32 internal constant MARKET_USDC = ArcMainnet.MARKET_USDC;
    bytes32 internal constant MARKET_EURC = ArcMainnet.MARKET_EURC;

    function setUp() public override {
        super.setUp();
        assertGe(CIRBTC.balanceOf(PAYER), 11_000, "demo wallet holds under 0.00011 cirBTC");
        assertGe(USDC.balanceOf(PAYER), 4e6, "demo wallet holds under 4 USDC");
        assertEq(_liveShares(MARKET_USDC), 0, "demo wallet already borrows USDC");
        assertEq(_liveShares(MARKET_EURC), 0, "demo wallet already borrows EURC");
    }

    function test_loanBackedPay_recordsCheckedDebt() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.35e18);
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, borrow, REF);
        IMulticall3From.Call3[] memory calls = loanCalls(PAYER, id, COLLATERAL, borrow);
        uint256 cirBtcBefore = CIRBTC.balanceOf(PAYER);
        uint256 usdcBefore = USDC.balanceOf(PAYER);

        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillPaid(id, PAYER, PAYEE, ArcMainnet.USDC, borrow, true);
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 shares = _liveShares(MARKET_USDC);
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertEq(records[0].marketId, MARKET_USDC);
        assertEq(records[0].shares, shares, "recorded shares are not the live shares");
        assertTrue(records[0].checked);
        assertEq(recordedShares(MARKET_USDC), shares);
        assertEq(records[0].collateral, COLLATERAL, "recorded collateral is not the live collateral");
        assertEq(recordedCollateral(MARKET_USDC), COLLATERAL);
        assertEq(USDC.balanceOf(PAYEE), borrow, "payee not credited exactly");
        assertEq(USDC.balanceOf(PAYER), usdcBefore, "the loan did not fund the bill");
        assertEq(cirBtcBefore - CIRBTC.balanceOf(PAYER), COLLATERAL);
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.35e18, 0.001e18);
        assertAdagHoldsNothing();
    }

    function test_boundary_40PercentLine() public {
        uint256 over = borrowForLtv(MARKET_USDC, COLLATERAL, 0.405e18);
        uint256 under = borrowForLtv(MARKET_USDC, COLLATERAL, 0.395e18);
        uint256 overId = makeBill(PAYEE, ArcMainnet.USDC, over, REF);
        uint256 underId = makeBill(PAYEE, ArcMainnet.USDC, under, REF);
        uint256 cirBtcBefore = CIRBTC.balanceOf(PAYER);

        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, overId, COLLATERAL, over));
        assertFalse(ok, "40.5% went through");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        (,, uint128 pledged) = MORPHO.position(MARKET_USDC, PAYER);
        assertEq(pledged, 0, "collateral left pledged");
        assertEq(CIRBTC.balanceOf(PAYER), cirBtcBefore);
        assertEq(uint8(adag.bill(overId).status), uint8(AdagBills.Status.Open));
        assertEq(USDC.balanceOf(PAYEE), 0, "payee credited by an undone batch");

        payWithLoan(PAYER, underId, COLLATERAL, under);
        assertEq(uint8(adag.bill(underId).status), uint8(AdagBills.Status.Paid));
        assertEq(USDC.balanceOf(PAYEE), under);
        assertLe(adag.loanToValue(PAYER, MARKET_USDC), 0.4e18);
    }

    function test_priceDrop_blocksOnlyNewDebt() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.35e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 price = IOracleMinimal(paramsOf(MARKET_USDC).oracle).price();
        mockPrice(MARKET_USDC, price * 35 / 75);
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.75e18, 0.001e18);

        uint256 cashId = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(cashId);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(_billPaidFlags(logs)[0], "cash payment was loan checked");
        assertEq(_debtRecords(logs).length, 0, "cash payment recorded debt");
        assertEq(USDC.balanceOf(PAYEE_B), SMALL);

        uint256 loanId = makeBill(PAYEE_C, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, loanId, 100, SMALL));
        assertFalse(ok, "new debt at 75% went through");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(uint8(adag.bill(loanId).status), uint8(AdagBills.Status.Open));
    }

    function test_laundering_borrowPastLineThenPayTinyBill() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, 0.01e6, REF);
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.6e18);

        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, id, COLLATERAL, borrow));

        assertFalse(ok, "borrowing to 60% beside a tiny bill went through");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(_liveShares(MARKET_USDC), 0);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    function test_laundering_borrowUsdcPastLineThenPayEurcBill() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.EURC, 0.2e6, REF);
        IMulticall3From.Call3[] memory tail = new IMulticall3From.Call3[](2);
        tail[0] = call3(ArcMainnet.EURC, abi.encodeCall(IERC20.approve, (address(adag), 0.2e6)));
        tail[1] = memoPayCall(id, REF);
        IMulticall3From.Call3[] memory calls = concat(
            concat(
                pledgeAndBorrowCalls(PAYER, MARKET_USDC, 8_000, borrowForLtv(MARKET_USDC, 8_000, 0.6e18)),
                pledgeAndBorrowCalls(PAYER, MARKET_EURC, 1_500, 0.2e6)
            ),
            tail
        );

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok, "USDC debt at 60% paid an EURC bill");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
        assertEq(EURC.balanceOf(PAYEE), 0);
    }

    function test_repayThenCashPay_lowersSeenShares() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.35e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 sharesBefore = _liveShares(MARKET_USDC);
        repayShares(PAYER, MARKET_USDC, sharesBefore / 2);
        uint256 sharesAfter = _liveShares(MARKET_USDC);
        assertLt(sharesAfter, sharesBefore);
        assertEq(USDC.allowance(PAYER, ArcMainnet.MORPHO), 0, "repay left an approval");

        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertEq(records[0].marketId, MARKET_USDC);
        assertEq(records[0].shares, sharesAfter);
        assertFalse(records[0].checked, "a lower debt was checked");
        assertFalse(_billPaidFlags(logs)[0]);
        assertEq(recordedShares(MARKET_USDC), sharesAfter);
        assertEq(records[0].collateral, COLLATERAL, "repaying changed the recorded collateral");
    }

    function test_unseenDebt_under40IsCheckedAndPasses() public {
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.3e18));
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);

        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(_billPaidFlags(logs)[0], "debt Adag never saw was not checked");
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertTrue(records[0].checked);
        assertEq(records[0].shares, _liveShares(MARKET_USDC));
        assertEq(USDC.balanceOf(PAYEE), SMALL);
    }

    function test_unseenDebt_above40IsRefused() public {
        borrowDirect(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.6e18));
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);

        (bool ok, bytes memory ret) = tryBatch(PAYER, cashCalls(id));

        assertFalse(ok, "a payer at 60% paid through Adag");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(recordedShares(MARKET_USDC), 0);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    function test_staleBtc_blocksNewDebtOnly() public {
        (,,, uint256 btcUpdatedAt,) = IChainlinkFeed(ArcMainnet.BTC_USD_FEED).latestRoundData();
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);

        vm.warp(block.timestamp + 27 hours);

        uint256 loanId = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, loanId, 500, SMALL));
        assertFalse(ok, "new debt on a 27 hour old BTC price went through");
        assertEq(
            adagError(ret), abi.encodeWithSelector(AdagBills.StalePrice.selector, ArcMainnet.BTC_USD_FEED, btcUpdatedAt)
        );

        uint256 cashId = makeBill(PAYEE_C, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(cashId);
        vm.recordLogs();
        runBatch(PAYER, calls);
        assertFalse(_billPaidFlags(vm.getRecordedLogs())[0]);
        assertEq(USDC.balanceOf(PAYEE_C), SMALL, "a stale price blocked a cash payment");
    }

    function test_staleEur_blocksEurcLoan() public {
        (,,, uint256 eurUpdatedAt,) = IChainlinkFeed(ArcMainnet.EUR_USD_FEED).latestRoundData();
        uint256 id = makeBill(PAYEE, ArcMainnet.EURC, 1e6, REF);

        vm.warp(block.timestamp + 97 hours);
        mockFreshFeed(ArcMainnet.BTC_USD_FEED);
        (bool btcFresh,,) = adag.priceStatus(MARKET_USDC);
        assertTrue(btcFresh, "BTC/USD mock did not hold");

        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, id, COLLATERAL, 1e6));

        assertFalse(ok, "EURC debt on a 97 hour old EUR price went through");
        assertEq(
            adagError(ret), abi.encodeWithSelector(AdagBills.StalePrice.selector, ArcMainnet.EUR_USD_FEED, eurUpdatedAt)
        );
    }

    function test_badMarket_refusesCreateAndLoanPay() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, borrow, REF);
        IMulticall3From.Call3[] memory calls = loanCalls(PAYER, id, COLLATERAL, borrow);
        MarketParams memory p = paramsOf(MARKET_USDC);
        vm.mockCall(
            ArcMainnet.MORPHO,
            abi.encodeCall(IMorphoBorrow.idToMarketParams, (MARKET_USDC)),
            abi.encode(p.loanToken, ArcMainnet.WETH, p.oracle, p.irm, p.lltv)
        );
        bytes memory badMarket = abi.encodeWithSelector(AdagBills.BadMarket.selector, MARKET_USDC);

        vm.expectRevert(badMarket);
        vm.prank(PAYEE);
        adag.createBill(ArcMainnet.USDC, SMALL, 0, REF);

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);
        assertFalse(ok, "paid against a market with the wrong collateral");
        assertEq(adagError(ret), badMarket);
    }

    function test_badUsdcMarket_leavesEurcBillsWritable() public {
        MarketParams memory p = paramsOf(MARKET_USDC);
        vm.mockCall(
            ArcMainnet.MORPHO,
            abi.encodeCall(IMorphoBorrow.idToMarketParams, (MARKET_USDC)),
            abi.encode(p.loanToken, ArcMainnet.WETH, p.oracle, p.irm, p.lltv)
        );

        vm.prank(PAYEE);
        uint256 id = adag.createBill(ArcMainnet.EURC, SMALL, 0, REF);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open), "a broken USDC market blocked EURC");

        vm.expectRevert(abi.encodeWithSelector(AdagBills.BadMarket.selector, MARKET_USDC));
        vm.prank(PAYEE);
        adag.createBill(ArcMainnet.USDC, SMALL, 0, REF);
    }

    function test_badFeed_refusesLoanPay() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        IMulticall3From.Call3[] memory calls =
            loanCalls(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        address oracle = paramsOf(MARKET_USDC).oracle;
        // Morpho's own price() reads the feed from an immutable, so only Adag's getter read sees zero.
        vm.mockCall(oracle, abi.encodeWithSelector(IOracleMinimal.BASE_FEED_1.selector), abi.encode(address(0)));

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok);
        assertEq(adagError(ret), abi.encodeWithSelector(AdagBills.BadFeed.selector, oracle));
    }

    function test_zeroPrice_refusesLoanPay() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        IMulticall3From.Call3[] memory calls =
            loanCalls(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        address oracle = paramsOf(MARKET_USDC).oracle;
        // Morpho's borrow reads price() once for its own health check, then Adag reads it. A plain zero for
        // every caller would stop the batch inside Morpho first, so the first read gets the real price.
        bytes[] memory answers = new bytes[](2);
        answers[0] = abi.encode(IOracleMinimal(oracle).price());
        answers[1] = abi.encode(uint256(0));
        vm.mockCalls(oracle, abi.encodeWithSelector(IOracleMinimal.price.selector), answers);

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok);
        assertEq(adagError(ret), abi.encodeWithSelector(AdagBills.ZeroPrice.selector));
    }

    function test_collateralNeeded_isExact() public {
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        uint256 target = 2e6;
        uint256 debt = _debtAfterBorrow(MARKET_USDC, target);
        uint256 need = adag.collateralNeeded(PAYER, MARKET_USDC, debt);
        assertLe(need, CIRBTC.balanceOf(PAYER));
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, target, REF);

        (bool ok, bytes memory ret) = tryBatch(PAYER, loanCalls(PAYER, id, need - 1, target));
        assertFalse(ok, "one satoshi under the suggestion went through");
        _assertLtvAboveLimit(ret, MARKET_USDC);

        payWithLoan(PAYER, id, need, target);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
        assertEq(adag.collateralNeeded(PAYER, MARKET_USDC, 0), 0, "a paid position still asks for collateral");

        (, uint128 shares, uint128 collateral) = MORPHO.position(MARKET_USDC, PAYER);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(MARKET_USDC);
        uint256 price = IOracleMinimal(paramsOf(MARKET_USDC).oracle).price();
        uint256 denominator = uint256(totalShares) + 1e6;
        uint256 borrowed = (uint256(shares) * (uint256(totalAssets) + 1) + denominator - 1) / denominator;
        uint256 value = uint256(collateral) * price / 1e36;
        uint256 expected = (borrowed * 1e18 + value - 1) / value;
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), expected, 1);
        assertLe(expected, 0.4e18);
    }

    function test_close_afterOneHour() public {
        _payThenClose(1 hours);
    }

    function test_close_afterThirtyDays() public {
        _payThenClose(30 days);
    }

    function test_threeBillsOneSignature() public {
        uint256 usdcBorrow = borrowForLtv(MARKET_USDC, 6_000, 0.3e18);
        uint256 eurcBorrow = borrowForLtv(MARKET_EURC, 4_000, 0.3e18);
        uint256 firstUsdc = usdcBorrow / 2;
        uint256 secondUsdc = usdcBorrow - firstUsdc;
        uint256 id1 = makeBill(PAYEE, ArcMainnet.USDC, firstUsdc, "A-1");
        uint256 id2 = makeBill(PAYEE_B, ArcMainnet.USDC, secondUsdc, "B-2");
        uint256 id3 = makeBill(PAYEE_C, ArcMainnet.EURC, eurcBorrow, "C-3");

        IMulticall3From.Call3[] memory tail = new IMulticall3From.Call3[](5);
        tail[0] = call3(ArcMainnet.USDC, abi.encodeCall(IERC20.approve, (address(adag), usdcBorrow)));
        tail[1] = call3(ArcMainnet.EURC, abi.encodeCall(IERC20.approve, (address(adag), eurcBorrow)));
        tail[2] = memoPayCall(id1, "A-1");
        tail[3] = memoPayCall(id2, "B-2");
        tail[4] = memoPayCall(id3, "C-3");
        IMulticall3From.Call3[] memory calls = concat(
            concat(
                pledgeAndBorrowCalls(PAYER, MARKET_USDC, 6_000, usdcBorrow),
                pledgeAndBorrowCalls(PAYER, MARKET_EURC, 4_000, eurcBorrow)
            ),
            tail
        );

        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(USDC.balanceOf(PAYEE), firstUsdc);
        assertEq(USDC.balanceOf(PAYEE_B), secondUsdc);
        assertEq(EURC.balanceOf(PAYEE_C), eurcBorrow);
        bool[] memory flags = _billPaidFlags(logs);
        assertEq(flags.length, 3);
        assertTrue(flags[0], "first payment not checked");
        assertFalse(flags[1], "second payment checked again");
        assertFalse(flags[2], "third payment checked again");
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 2, "both markets recorded once, in the first payment");
        assertEq(records[0].marketId, MARKET_USDC);
        assertEq(records[1].marketId, MARKET_EURC);
        bytes32[] memory memoIds = _memoIds(logs);
        assertEq(memoIds.length, 3);
        assertEq(memoIds[0], bytes32(id1));
        assertEq(memoIds[1], bytes32(id2));
        assertEq(memoIds[2], bytes32(id3));
        assertEq(USDC.allowance(PAYER, address(adag)), 0);
        assertEq(EURC.allowance(PAYER, address(adag)), 0);
        assertAdagHoldsNothing();
    }

    /// @dev The threat model's named residual (C10): Adag checks debt when its own step runs, so a payer who
    /// hand-builds a batch can borrow more after it. Only the payer's own position is at risk.
    function test_residual_borrowAfterPayIsNotCaught() public {
        uint256 id = makeBill(PAYEE, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = concat(
            cashCalls(id),
            pledgeAndBorrowCalls(PAYER, MARKET_USDC, COLLATERAL, borrowForLtv(MARKET_USDC, COLLATERAL, 0.6e18))
        );

        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid), "the accepted residual changed");
        assertFalse(_billPaidFlags(logs)[0]);
        assertEq(_debtRecords(logs).length, 0);
        assertEq(recordedShares(MARKET_USDC), 0);
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.6e18, 0.001e18);
    }

    /// @dev The backend-gate finding: close outside Adag, re-pledge a quarter of the collateral, borrow back the
    /// exact share count Adag recorded, and pay. Same shares, much less collateral: about 80%.
    function test_bypass_sameSharesLessCollateralIsRefused() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 recordedShares = _liveShares(MARKET_USDC);
        closeLoan(PAYER, MARKET_USDC);

        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls =
            concat(concat(pledgeCalls(PAYER, MARKET_USDC, 2_500), borrowSharesCalls(PAYER, MARKET_USDC, recordedShares)), cashCalls(id));

        (bool ok, bytes memory ret) = tryBatch(PAYER, calls);

        assertFalse(ok, "same shares on a quarter of the collateral skipped the check");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    /// @dev The mirror case: the same share count on more collateral than Adag accepted is a safer position, so
    /// it is recorded and not checked.
    function test_dominatedPosition_skipsCheck() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.35e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 recorded = recordedShares(MARKET_USDC);
        assertEq(recordedCollateral(MARKET_USDC), COLLATERAL);
        closeLoan(PAYER, MARKET_USDC);

        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = concat(
            concat(pledgeCalls(PAYER, MARKET_USDC, COLLATERAL + 1_000), borrowSharesCalls(PAYER, MARKET_USDC, recorded)),
            cashCalls(id)
        );
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(_billPaidFlags(logs)[0], "a safer position than the accepted one was checked");
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1, "the collateral change was not recorded");
        assertEq(records[0].shares, recorded);
        assertEq(records[0].collateral, COLLATERAL + 1_000);
        assertFalse(records[0].checked);
        assertEq(recordedCollateral(MARKET_USDC), COLLATERAL + 1_000);
    }

    function test_addCollateralOnly_recordsWithoutCheck() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        uint256 shares = recordedShares(MARKET_USDC);
        runBatch(PAYER, pledgeCalls(PAYER, MARKET_USDC, 1_000));

        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(_billPaidFlags(logs)[0], "adding collateral triggered the check");
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertEq(records[0].shares, shares);
        assertEq(records[0].collateral, COLLATERAL + 1_000);
        assertFalse(records[0].checked);
    }

    function test_withdrawCollateralOutside_thenCashPay_isChecked() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);

        // 20% on 10,000 satoshis is 30% on two thirds of them.
        runBatch(PAYER, withdrawCollateralCalls(PAYER, MARKET_USDC, COLLATERAL / 3));
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.3e18, 0.001e18);
        uint256 thirtyId = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(thirtyId);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_billPaidFlags(logs)[0], "less collateral with debt was not checked");
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertTrue(records[0].checked);
        assertEq(records[0].collateral, COLLATERAL - COLLATERAL / 3);

        // And 20% on 10,000 is 60% on a third of them.
        runBatch(PAYER, withdrawCollateralCalls(PAYER, MARKET_USDC, COLLATERAL / 3));
        assertApproxEqAbs(adag.loanToValue(PAYER, MARKET_USDC), 0.6e18, 0.001e18);
        uint256 sixtyId = makeBill(PAYEE_C, ArcMainnet.USDC, SMALL, REF);
        (bool ok, bytes memory ret) = tryBatch(PAYER, cashCalls(sixtyId));
        assertFalse(ok, "a cash payment at 60% after withdrawing collateral went through");
        _assertLtvAboveLimit(ret, MARKET_USDC);
        assertEq(uint8(adag.bill(sixtyId).status), uint8(AdagBills.Status.Open));
    }

    /// @dev With no debt left, less collateral cannot be unsafe, so repaying everything and taking some cirBTC
    /// back is recorded without a check.
    function test_repayAll_recordsZeroWithoutCheck() public {
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        repayShares(PAYER, MARKET_USDC, _liveShares(MARKET_USDC));
        runBatch(PAYER, withdrawCollateralCalls(PAYER, MARKET_USDC, COLLATERAL / 2));

        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(_billPaidFlags(logs)[0]);
        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertEq(records[0].shares, 0);
        assertEq(records[0].collateral, COLLATERAL - COLLATERAL / 2);
        assertFalse(records[0].checked, "a position with no debt was checked");
        assertEq(recordedShares(MARKET_USDC), 0);
    }

    /// @dev The freshness check reads BASE_FEED_1, and QUOTE_FEED_1 for EURC, and assumes nothing else feeds the
    /// price. This pins that layout, so a change in either oracle shows up here first.
    function test_oracleLayout_isPinned() public view {
        _assertLayout(MARKET_USDC, address(0));
        _assertLayout(MARKET_EURC, ArcMainnet.EUR_USD_FEED);
    }

    function _assertLayout(bytes32 marketId, address quoteFeed) internal view {
        IOracleLayout oracle = IOracleLayout(paramsOf(marketId).oracle);
        assertEq(oracle.BASE_VAULT(), address(0), "BASE_VAULT");
        assertEq(oracle.BASE_FEED_1(), ArcMainnet.BTC_USD_FEED, "BASE_FEED_1");
        assertEq(oracle.BASE_FEED_2(), address(0), "BASE_FEED_2");
        assertEq(oracle.QUOTE_VAULT(), address(0), "QUOTE_VAULT");
        assertEq(oracle.QUOTE_FEED_1(), quoteFeed, "QUOTE_FEED_1");
        assertEq(oracle.QUOTE_FEED_2(), address(0), "QUOTE_FEED_2");
    }

    function _payThenClose(uint256 wait) internal {
        uint256 cirBtcStart = CIRBTC.balanceOf(PAYER);
        uint256 borrow = borrowForLtv(MARKET_USDC, COLLATERAL, 0.2e18);
        payWithLoan(PAYER, makeBill(PAYEE, ArcMainnet.USDC, borrow, REF), COLLATERAL, borrow);
        assertGt(recordedShares(MARKET_USDC), 0);

        vm.warp(block.timestamp + wait);
        closeLoan(PAYER, MARKET_USDC);

        (, uint128 shares, uint128 collateral) = MORPHO.position(MARKET_USDC, PAYER);
        assertEq(shares, 0, "debt left after close");
        assertEq(collateral, 0, "collateral left after close");
        assertEq(CIRBTC.balanceOf(PAYER), cirBtcStart, "cirBTC not returned in full");
        assertEq(USDC.allowance(PAYER, ArcMainnet.MORPHO), 0, "USDC approval left to Morpho");
        assertEq(CIRBTC.allowance(PAYER, ArcMainnet.MORPHO), 0, "cirBTC approval left to Morpho");

        // A decrease is recorded without the freshness check, so no feed needs mocking even 30 days on.
        uint256 id = makeBill(PAYEE_B, ArcMainnet.USDC, SMALL, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.recordLogs();
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        DebtRecord[] memory records = _debtRecords(logs);
        assertEq(records.length, 1);
        assertEq(records[0].marketId, MARKET_USDC);
        assertEq(records[0].shares, 0);
        assertEq(records[0].collateral, 0);
        assertFalse(records[0].checked);
        assertFalse(_billPaidFlags(logs)[0]);
        assertEq(recordedShares(MARKET_USDC), 0);
    }

    /// @dev What Adag will compute as the payer's debt right after Morpho lends `assets` from a fresh position, in
    /// a block where interest is already accrued: Morpho mints shares rounding up, Adag converts back rounding up.
    function _debtAfterBorrow(bytes32 marketId, uint256 assets) internal view returns (uint256) {
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        uint256 shares = Math.mulDiv(assets, uint256(totalShares) + 1e6, uint256(totalAssets) + 1, Math.Rounding.Ceil);
        return Math.mulDiv(
            shares, uint256(totalAssets) + assets + 1, uint256(totalShares) + shares + 1e6, Math.Rounding.Ceil
        );
    }

    function _assertLtvAboveLimit(bytes memory ret, bytes32 marketId) internal view {
        bytes memory err = adagError(ret);
        assertEq(bytes4(err), AdagBills.LtvAboveLimit.selector, "not LtvAboveLimit");
        (bytes32 failedMarket, uint256 borrowed, uint256 maxBorrow) =
            abi.decode(this.dropSelector(err), (bytes32, uint256, uint256));
        assertEq(failedMarket, marketId, "refused in the wrong market");
        assertGt(borrowed, maxBorrow);
    }

    function _liveShares(bytes32 marketId) internal view returns (uint256) {
        (, uint128 shares,) = MORPHO.position(marketId, PAYER);
        return shares;
    }

    function _debtRecords(Vm.Log[] memory logs) internal view returns (DebtRecord[] memory records) {
        records = new DebtRecord[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.DebtRecorded.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(PAYER))), "debt recorded for someone else");
                (uint256 shares, uint256 collateral, bool checked) = abi.decode(logs[i].data, (uint256, uint256, bool));
                records[n++] = DebtRecord(logs[i].topics[2], shares, collateral, checked);
            }
        }
        assembly ("memory-safe") {
            mstore(records, n)
        }
    }

    function _billPaidFlags(Vm.Log[] memory logs) internal view returns (bool[] memory flags) {
        flags = new bool[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.BillPaid.selector) {
                (,, bool loanChecked) = abi.decode(logs[i].data, (address, uint256, bool));
                flags[n++] = loanChecked;
            }
        }
        assembly ("memory-safe") {
            mstore(flags, n)
        }
    }

    function _memoIds(Vm.Log[] memory logs) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ArcMainnet.MEMO && logs[i].topics[0] == IMemo.Memo.selector) {
                ids[n++] = logs[i].topics[3];
            }
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
    }
}
