// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Fork tests for AdagBills on Arc mainnet: writing, voiding and paying bills from a cash balance through Memo
// and Multicall3From, the views, the events, every revert, and price freshness.
// Not covered here: payments that add Morpho debt and the 40% rule (loanToValue, collateralNeeded, LtvAboveLimit,
// StalePrice and ZeroPrice inside pay, DebtRecorded) are in AdagLoanRule.t.sol; enrol and the same-block refusal
// are in AdagEnrol.t.sol; fuzz and invariant tests are in AdagFuzz.t.sol and invariant/. EURC is only written,
// never paid, in this file. Results follow mainnet state at
// the block run-tests.sh pins: the demo wallet must hold 3 USDC and no Morpho debt in either Adag market there.

import {Vm} from "forge-std/Test.sol";
import {AdagBills} from "../src/AdagBills.sol";
import {IChainlinkFeed} from "../src/interfaces/IChainlinkFeed.sol";
import {AdagFixture} from "./utils/AdagFixture.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {IMemo, IMulticall3From} from "./utils/ArcInterfaces.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A payee that is a contract with no functions at all, standing in for a multisig or a smart account.
contract CodePayee {}

contract AdagBillsTest is AdagFixture {
    address internal constant SUPPLIER = address(0x5A11E5);
    address internal constant OTHER_SUPPLIER = address(0x0B5E55);
    address internal constant BYSTANDER = address(0xB1257A);
    uint256 internal constant AMOUNT = 1e6;
    uint64 internal constant DUE = 1_790_000_000;
    bytes internal constant REF = "INV-2026-0042";

    function setUp() public override {
        super.setUp();
        assertGe(USDC.balanceOf(PAYER), 3e6, "demo wallet holds under 3 USDC");
    }

    function test_createBill_usdc() public {
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillCreated(1, SUPPLIER, ArcMainnet.USDC, AMOUNT, DUE, REF);
        vm.prank(SUPPLIER);
        uint256 id = adag.createBill(ArcMainnet.USDC, AMOUNT, DUE, REF);

        assertEq(id, 1, "ids start at 1");
        assertEq(adag.billCount(), 1);
        AdagBills.Bill memory b = adag.bill(id);
        assertEq(b.payee, SUPPLIER);
        assertEq(uint8(b.status), uint8(AdagBills.Status.Open));
        assertEq(b.due, DUE);
        assertEq(b.currency, ArcMainnet.USDC);
        assertEq(b.createdAt, block.timestamp);
        assertEq(b.amount, AMOUNT);
        assertEq(b.payer, address(0));
        assertEq(b.paidAt, 0);
        assertEq(b.ref, REF);
    }

    function test_createBill_eurc() public {
        makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillCreated(2, SUPPLIER, ArcMainnet.EURC, 250e6, 0, "");
        vm.prank(SUPPLIER);
        uint256 id = adag.createBill(ArcMainnet.EURC, 250e6, 0, "");

        assertEq(id, 2);
        AdagBills.Bill memory b = adag.bill(id);
        assertEq(b.currency, ArcMainnet.EURC);
        assertEq(b.amount, 250e6);
        assertEq(uint8(b.status), uint8(AdagBills.Status.Open));
        assertEq(b.ref.length, 0);
    }

    function test_createBill_revertsZeroAmount() public {
        vm.expectRevert(AdagBills.ZeroAmount.selector);
        vm.prank(SUPPLIER);
        adag.createBill(ArcMainnet.USDC, 0, 0, REF);
    }

    function test_createBill_referenceCapIs140Bytes() public {
        vm.prank(SUPPLIER);
        uint256 id = adag.createBill(ArcMainnet.USDC, AMOUNT, 0, _bytesOfLength(140));
        assertEq(adag.bill(id).ref.length, 140, "140 bytes is allowed");

        vm.expectRevert(abi.encodeWithSelector(AdagBills.ReferenceTooLong.selector, 141));
        vm.prank(SUPPLIER);
        adag.createBill(ArcMainnet.USDC, AMOUNT, 0, _bytesOfLength(141));
    }

    function test_createBill_revertsCirBtcCurrency() public {
        _expectUnsupported(ArcMainnet.CIRBTC);
    }

    function test_createBill_revertsWethCurrency() public {
        _expectUnsupported(ArcMainnet.WETH);
    }

    function test_createBill_revertsRandomCurrency() public {
        _expectUnsupported(makeAddr("not a token"));
    }

    function test_voidBill() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillVoided(id, SUPPLIER);
        vm.prank(SUPPLIER);
        adag.voidBill(id);

        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Void));
    }

    function test_voidBill_revertsNonPayee() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.NotPayee.selector, OTHER_SUPPLIER));
        vm.prank(OTHER_SUPPLIER);
        adag.voidBill(id);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    function test_voidBill_revertsPaidBill() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        payCash(PAYER, id);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.BillNotOpen.selector, id, AdagBills.Status.Paid));
        vm.prank(SUPPLIER);
        adag.voidBill(id);
        assertAdagHoldsNothing();
    }

    function test_pay_cashThroughMemo() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        IMulticall3From.Call3[] memory calls = cashCalls(id);
        uint256 payerBefore = USDC.balanceOf(PAYER);
        uint256 payeeBefore = USDC.balanceOf(SUPPLIER);

        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(adag));
        emit AdagBills.BillPaid(id, PAYER, SUPPLIER, ArcMainnet.USDC, AMOUNT, false);
        runBatch(PAYER, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(payerBefore - USDC.balanceOf(PAYER), AMOUNT, "payer not debited exactly");
        assertEq(USDC.balanceOf(SUPPLIER) - payeeBefore, AMOUNT, "payee not credited exactly");
        assertEq(USDC.allowance(PAYER, address(adag)), 0, "approval left over");
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Paid));
        assertEq(recordedShares(ArcMainnet.MARKET_USDC), 0);
        assertEq(recordedShares(ArcMainnet.MARKET_EURC), 0);
        _assertMemoForBill(logs, id);
        _assertNoDebtRecorded(logs);
        assertAdagHoldsNothing();
    }

    function test_pay_revertsSecondPayment() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        payCash(PAYER, id);
        uint256 payeeAfterFirst = USDC.balanceOf(SUPPLIER);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.BillNotOpen.selector, id, AdagBills.Status.Paid));
        vm.prank(PAYER);
        adag.pay(id);

        IMulticall3From.Call3[] memory calls = cashCalls(id);
        vm.expectPartialRevert(IMemo.MemoFailed.selector);
        runBatch(PAYER, calls);

        assertEq(USDC.balanceOf(SUPPLIER), payeeAfterFirst, "payee paid twice");
        (, uint256 total) = adag.paymentsOfPayer(PAYER, 0, 10);
        assertEq(total, 1);
        assertAdagHoldsNothing();
    }

    function test_pay_revertsVoidedBill() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        vm.prank(SUPPLIER);
        adag.voidBill(id);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.BillNotOpen.selector, id, AdagBills.Status.Void));
        vm.prank(PAYER);
        adag.pay(id);
    }

    function test_pay_revertsUnknownBill() public {
        makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.UnknownBill.selector, 0));
        vm.prank(PAYER);
        adag.pay(0);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.UnknownBill.selector, 2));
        vm.prank(PAYER);
        adag.pay(2);
    }

    function test_pay_revertsSelfPayment() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        vm.expectRevert(AdagBills.SelfPayment.selector);
        vm.prank(SUPPLIER);
        adag.pay(id);
        assertEq(uint8(adag.bill(id).status), uint8(AdagBills.Status.Open));
    }

    function test_pay_noAllowanceRevertsWholeBatch() public {
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        IMulticall3From.Call3[] memory calls = new IMulticall3From.Call3[](2);
        // A first step with a visible effect, so the test can see it undone along with the failed payment.
        calls[0] = call3(ArcMainnet.USDC, abi.encodeCall(IERC20.transfer, (BYSTANDER, 1)));
        calls[1] = memoPayCall(id, REF);
        uint256 payerBefore = USDC.balanceOf(PAYER);
        uint256 payeeBefore = USDC.balanceOf(SUPPLIER);

        vm.expectPartialRevert(IMemo.MemoFailed.selector);
        runBatch(PAYER, calls);

        AdagBills.Bill memory b = adag.bill(id);
        assertEq(uint8(b.status), uint8(AdagBills.Status.Open), "marked paid without payment");
        assertEq(b.payer, address(0));
        (, uint256 total) = adag.paymentsOfPayer(PAYER, 0, 10);
        assertEq(total, 0, "payment listed");
        assertEq(USDC.balanceOf(PAYER), payerBefore);
        assertEq(USDC.balanceOf(SUPPLIER), payeeBefore);
        assertEq(USDC.balanceOf(BYSTANDER), 0, "earlier step in the batch survived");
        assertAdagHoldsNothing();
    }

    function test_bill_viewBeforeAndAfterPayment() public {
        assertEq(uint8(adag.bill(1).status), uint8(AdagBills.Status.None), "unwritten id");
        uint256 id = makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        AdagBills.Bill memory before = adag.bill(id);
        assertEq(uint8(before.status), uint8(AdagBills.Status.Open));
        assertEq(before.payer, address(0));
        assertEq(before.paidAt, 0);

        vm.warp(block.timestamp + 1 hours);
        payCash(PAYER, id);

        AdagBills.Bill memory paid = adag.bill(id);
        assertEq(uint8(paid.status), uint8(AdagBills.Status.Paid));
        assertEq(paid.payer, PAYER);
        assertEq(paid.paidAt, block.timestamp);
        assertEq(paid.payee, before.payee);
        assertEq(paid.due, before.due);
        assertEq(paid.currency, before.currency);
        assertEq(paid.createdAt, before.createdAt);
        assertEq(paid.amount, before.amount);
        assertEq(paid.ref, before.ref);
        assertAdagHoldsNothing();
    }

    function test_billsOfPayee_pagination() public {
        makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        makeBill(OTHER_SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);
        makeBill(SUPPLIER, ArcMainnet.EURC, AMOUNT, REF);
        makeBill(SUPPLIER, ArcMainnet.USDC, AMOUNT, REF);

        (uint256[] memory ids, uint256 total) = adag.billsOfPayee(SUPPLIER, 0, 2);
        assertEq(total, 3);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 3);

        (ids, total) = adag.billsOfPayee(SUPPLIER, 2, 2);
        assertEq(ids.length, 1);
        assertEq(ids[0], 4);

        (ids, total) = adag.billsOfPayee(SUPPLIER, 3, 100);
        assertEq(ids.length, 0, "offset at the end");
        assertEq(total, 3);
        (ids,) = adag.billsOfPayee(SUPPLIER, type(uint256).max, 100);
        assertEq(ids.length, 0, "offset past the end");

        (ids, total) = adag.billsOfPayee(OTHER_SUPPLIER, 0, 100);
        assertEq(total, 1);
        assertEq(ids[0], 2);

        vm.expectRevert(abi.encodeWithSelector(AdagBills.PageTooLarge.selector, 101));
        adag.billsOfPayee(SUPPLIER, 0, 101);
    }

    function test_paymentsOfPayer_pagination() public {
        uint256 first = makeBill(SUPPLIER, ArcMainnet.USDC, 0.5e6, REF);
        uint256 second = makeBill(OTHER_SUPPLIER, ArcMainnet.USDC, 0.5e6, REF);
        uint256 third = makeBill(SUPPLIER, ArcMainnet.USDC, 0.5e6, REF);
        payCash(PAYER, third);
        payCash(PAYER, first);
        payCash(PAYER, second);

        (uint256[] memory ids, uint256 total) = adag.paymentsOfPayer(PAYER, 0, 2);
        assertEq(total, 3);
        assertEq(ids.length, 2);
        assertEq(ids[0], third, "listed in payment order");
        assertEq(ids[1], first);

        (ids,) = adag.paymentsOfPayer(PAYER, 2, 5);
        assertEq(ids.length, 1);
        assertEq(ids[0], second);

        (ids, total) = adag.paymentsOfPayer(PAYER, 7, 5);
        assertEq(ids.length, 0, "offset past the end");
        assertEq(total, 3);

        (, total) = adag.paymentsOfPayer(SUPPLIER, 0, 5);
        assertEq(total, 0, "payee is not a payer");

        vm.expectRevert(abi.encodeWithSelector(AdagBills.PageTooLarge.selector, 101));
        adag.paymentsOfPayer(PAYER, 0, 101);
        assertAdagHoldsNothing();
    }

    function test_pay_contractPayeeReceives() public {
        address payee = address(new CodePayee());
        assertGt(payee.code.length, 0);
        uint256 id = makeBill(payee, ArcMainnet.USDC, AMOUNT, REF);

        payCash(PAYER, id);

        assertEq(USDC.balanceOf(payee), AMOUNT, "contract payee not credited");
        assertEq(adag.bill(id).payer, PAYER);
        assertAdagHoldsNothing();
    }

    function test_priceStatus_freshNow() public view {
        (bool fresh, uint256 btcAt, uint256 eurAt) = adag.priceStatus(ArcMainnet.MARKET_USDC);
        assertTrue(fresh, "USDC market stale at the fork block");
        assertGt(btcAt, 0);
        assertEq(eurAt, 0, "USDC market has no EUR/USD feed");

        uint256 btcAtEurc;
        (fresh, btcAtEurc, eurAt) = adag.priceStatus(ArcMainnet.MARKET_EURC);
        assertTrue(fresh, "EURC market stale at the fork block");
        assertEq(btcAtEurc, btcAt, "both markets share the BTC/USD feed");
        assertGt(eurAt, 0);
    }

    function test_priceStatus_revertsOtherMarket() public {
        bytes32 otherCirBtcMarket = 0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566;
        vm.expectRevert(abi.encodeWithSelector(AdagBills.BadMarket.selector, otherCirBtcMarket));
        adag.priceStatus(otherCirBtcMarket);
    }

    function test_priceStatus_btcStaleAfter26Hours() public {
        (, uint256 btcAt,) = adag.priceStatus(ArcMainnet.MARKET_USDC);

        vm.warp(btcAt + 26 hours);
        (bool fresh,,) = adag.priceStatus(ArcMainnet.MARKET_USDC);
        assertTrue(fresh, "exactly 26 hours old is still fresh");

        vm.warp(btcAt + 26 hours + 1);
        uint256 btcAtLater;
        (fresh, btcAtLater,) = adag.priceStatus(ArcMainnet.MARKET_USDC);
        assertFalse(fresh, "USDC market fresh past 26 hours");
        assertEq(btcAtLater, btcAt);
        (fresh,,) = adag.priceStatus(ArcMainnet.MARKET_EURC);
        assertFalse(fresh, "EURC market fresh with a stale BTC/USD");
    }

    function test_priceStatus_eurStaleAfter96Hours() public {
        (,, uint256 eurAt) = adag.priceStatus(ArcMainnet.MARKET_EURC);

        vm.warp(eurAt + 96 hours);
        _mockFreshBtcUsd();
        (bool fresh,,) = adag.priceStatus(ArcMainnet.MARKET_EURC);
        assertTrue(fresh, "exactly 96 hours old is still fresh");

        vm.warp(eurAt + 96 hours + 1);
        _mockFreshBtcUsd();
        uint256 eurAtLater;
        (fresh,, eurAtLater) = adag.priceStatus(ArcMainnet.MARKET_EURC);
        assertFalse(fresh, "EURC market fresh past 96 hours");
        assertEq(eurAtLater, eurAt);
        (fresh,,) = adag.priceStatus(ArcMainnet.MARKET_USDC);
        assertTrue(fresh, "a stale EUR/USD must not affect the USDC market");
    }

    function _expectUnsupported(address currency) internal {
        vm.expectRevert(abi.encodeWithSelector(AdagBills.UnsupportedCurrency.selector, currency));
        vm.prank(SUPPLIER);
        adag.createBill(currency, AMOUNT, 0, REF);
    }

    // Isolates the EUR/USD age: without this, BTC/USD would also be stale this far ahead.
    function _mockFreshBtcUsd() internal {
        vm.mockCall(
            ArcMainnet.BTC_USD_FEED,
            abi.encodeWithSelector(IChainlinkFeed.latestRoundData.selector),
            abi.encode(uint80(1), int256(100_000e8), block.timestamp, block.timestamp, uint80(1))
        );
    }

    function _bytesOfLength(uint256 length) internal pure returns (bytes memory b) {
        b = new bytes(length);
        for (uint256 i; i < length; ++i) {
            b[i] = "x";
        }
    }

    function _assertMemoForBill(Vm.Log[] memory logs, uint256 id) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ArcMainnet.MEMO && logs[i].topics[0] == IMemo.Memo.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(PAYER))), "memo sender");
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(adag)))), "memo target");
                assertEq(logs[i].topics[3], bytes32(id), "memoId is not the bill id");
                (bytes32 callDataHash, bytes memory memoData,) = abi.decode(logs[i].data, (bytes32, bytes, uint256));
                assertEq(callDataHash, keccak256(payData(id)), "memo wrapped a different call");
                assertEq(memoData, REF, "memo data is not the bill reference");
                return;
            }
        }
        revert("no Memo event");
    }

    function _assertNoDebtRecorded(Vm.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adag)) {
                assertTrue(logs[i].topics[0] != AdagBills.DebtRecorded.selector, "cash payment recorded debt");
            }
        }
    }
}
