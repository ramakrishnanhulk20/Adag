// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Invariant tests for AdagBills on an Arc mainnet fork. AdagHandler runs random sequences of bill writing, voiding,
// cash and loan-backed payments, Morpho borrowing and repaying outside Adag, attempts to reuse a recorded share
// count on different collateral, enrolments, a borrow, enrol and pay in one batch, time passing and price moves,
// and these seven rules must hold after every step.
// Not covered here: liquidations, token pauses and blocklists, more than two payers, feeds that go stale on their
// own (the handler keeps them fresh so loans can happen; staleness is proven in AdagLoanRule), and real signed
// transactions. Payers are funded with deal(): each gets 0.05 cirBTC, 1,000 USDC and 1,000 EURC, which replaces
// the demo wallet's real balances for this file.

import {AdagBills} from "../../src/AdagBills.sol";import {AdagFixture} from "../utils/AdagFixture.sol";
import {ArcMainnet} from "../utils/ArcMainnet.sol";
import {AdagHandler} from "./AdagHandler.sol";

contract AdagInvariantTest is AdagFixture {
    AdagHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[4] memory payees = [makeAddr("payee 1"), makeAddr("payee 2"), makeAddr("payee 3"), makeAddr("payee 4")];
        address[2] memory payers = [PAYER, makeAddr("payer 2")];
        for (uint256 i; i < payers.length; ++i) {
            deal(ArcMainnet.CIRBTC, payers[i], 5e6);
            deal(ArcMainnet.EURC, payers[i], 1_000e6);
            // Native USDC has 18 decimals; the ERC-20 face reads this as 1,000 USDC.
            vm.deal(payers[i], 1_000e18);
        }
        handler = new AdagHandler(adag, payees, payers);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = AdagHandler.createBill.selector;
        selectors[1] = AdagHandler.voidBill.selector;
        selectors[2] = AdagHandler.payFromBalance.selector;
        selectors[3] = AdagHandler.payFromLoan.selector;
        selectors[4] = AdagHandler.borrowOutsideAdag.selector;
        selectors[5] = AdagHandler.repayPart.selector;
        selectors[6] = AdagHandler.passTime.selector;
        selectors[7] = AdagHandler.movePrice.selector;
        selectors[8] = AdagHandler.reuseRecordedShares.selector;
        selectors[9] = AdagHandler.enrol.selector;
        selectors[10] = AdagHandler.borrowEnrolAndPay.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        // Left free, the fuzzer draws callers from addresses it finds in state, and Arc refuses any call from an
        // address on its native blocklist (Circle's tokens list themselves). The handler pranks the real actor.
        targetSender(makeAddr("fuzz caller"));
    }

    /// I1 (C2): Adag never holds a token between calls.
    function invariant_I1_adagHoldsNothing() public view {
        assertAdagHoldsNothing();
    }

    /// I2 (C6, C9): a bill only moves Open to Paid or Open to Void, and is paid at most once.
    function invariant_I2_statusOnlyMovesForward() public view {
        assertEq(handler.statusBreaks(), 0, handler.firstBreak());
        for (uint256 id = 1; id <= handler.created(); ++id) {
            AdagHandler.Ghost memory g = handler.ghostOf(id);
            assertEq(uint8(adag.bill(id).status), uint8(g.status), "bill status differs from the ghost");
            assertLe(g.timesPaid, 1, "a bill was paid twice");
        }
    }

    /// I3 (C1): payees received exactly the sum of the amounts of the bills paid to them, no more, no less.
    function invariant_I3_payeesCreditedExactly() public view {
        assertEq(handler.creditBreaks(), 0, handler.firstBreak());
        uint256 usdc;
        uint256 eurc;
        for (uint256 i; i < 4; ++i) {
            usdc += USDC.balanceOf(handler.payeeAt(i));
            eurc += EURC.balanceOf(handler.payeeAt(i));
        }
        assertEq(usdc, handler.paidUsdc(), "USDC credited to payees differs from bills paid");
        assertEq(eurc, handler.paidEurc(), "EURC credited to payees differs from bills paid");
    }

    /// I4: after every successful payment, the recorded shares and collateral equal the live position in both
    /// markets.
    function invariant_I4_recordedPositionMatchesAfterPay() public view {
        assertEq(handler.bookkeepingBreaks(), 0, handler.firstBreak());
    }

    /// I5 (C10): after every successful payment that ran the 40% check in a market, that market's debt was at or
    /// under 40%.
    function invariant_I5_newDebtWithinLine() public view {
        assertEq(handler.lineBreaks(), 0, handler.firstBreak());
    }

    /// I6 (C5): billCount equals the bills written, and the ids are exactly 1 to N.
    function invariant_I6_idsAreOneToN() public view {
        uint256 n = handler.created();
        assertEq(handler.idBreaks(), 0, handler.firstBreak());
        assertEq(adag.billCount(), n, "billCount differs from bills written");
        assertEq(uint8(adag.bill(n + 1).status), uint8(AdagBills.Status.None), "a bill exists past N");
        for (uint256 id = 1; id <= n; ++id) {
            assertEq(adag.bill(id).payee, handler.ghostOf(id).payee, "bill payee differs from its writer");
        }
    }

    /// I7 (C10, C32): after every successful payment, in each market where the payer has debt, either that payment
    /// ran the 40% check or the live position is no less safe than the last one a check accepted or an enrolment
    /// recorded (shares no higher, collateral no lower). No payment goes through in the block of the payer's own
    /// enrolment. Also: whether the check ran matches the rule exactly.
    function invariant_I7_uncheckedDebtIsDominated() public view {
        assertEq(handler.dominanceBreaks(), 0, handler.firstBreak());
        assertEq(handler.sameBlockBreaks(), 0, handler.firstBreak());
        assertEq(handler.decisionBreaks(), 0, handler.firstBreak());
    }
}

// The negative control for I7's same-block detector (C32): the handler must count a break when a contract lets a
// payment through in the block of the payer's own enrolment, and stay silent on the real AdagBills.
// The broken contract is AdagBills' own runtime code with one opcode changed: the block.number read in pay's
// enrol-block guard becomes chainid, so the guard compares the enrol block with 5042 and never fires. Everything
// else is byte for byte the real contract, and AdagBills sets no state in its constructor, so placing this code
// at an address is the same as deploying it.
// Not covered here: random sequences (AdagInvariantTest runs those), and the other I7 counters on their own.
contract AdagSameBlockDetectorTest is AdagFixture {
    address internal constant GUARDLESS = address(0xADA9BAD);

    AdagHandler internal realHandler;
    AdagHandler internal brokenHandler;

    function setUp() public override {
        super.setUp();
        address[4] memory payees = [makeAddr("payee 1"), makeAddr("payee 2"), makeAddr("payee 3"), makeAddr("payee 4")];
        address[2] memory payers = [PAYER, makeAddr("payer 2")];
        for (uint256 i; i < payers.length; ++i) {
            deal(ArcMainnet.CIRBTC, payers[i], 5e6);
            deal(ArcMainnet.EURC, payers[i], 1_000e6);
            vm.deal(payers[i], 1_000e18);
        }
        vm.etch(GUARDLESS, _guardlessCode());
        vm.label(GUARDLESS, "AdagBills without the enrol-block guard");
        realHandler = new AdagHandler(adag, payees, payers);
        brokenHandler = new AdagHandler(AdagBills(GUARDLESS), payees, payers);
    }

    function test_detector_firesWhenGuardRemoved_oneBatch() public {
        brokenHandler.createBill(0, false, 1e6);
        brokenHandler.borrowEnrolAndPay(0, 50_000, 6_000, 0);

        assertEq(brokenHandler.successfulPays(), 1, "the broken contract refused the one-batch payment");
        assertEq(brokenHandler.sameBlockBreaks(), 1, "the detector missed a borrow, enrol and pay in one batch");
        assertEq(brokenHandler.firstBreak(), "a payment went through in the block of the payer's enrolment");
    }

    function test_detector_firesWhenGuardRemoved_twoTransactions() public {
        brokenHandler.createBill(0, false, 1e6);
        brokenHandler.enrol(0);
        brokenHandler.payFromBalance(1, 0);

        assertEq(brokenHandler.successfulPays(), 1, "the broken contract refused the same-block payment");
        assertEq(brokenHandler.sameBlockBreaks(), 1, "the detector missed an enrol and a pay in one block");
    }

    function test_detector_silentOnRealContract() public {
        realHandler.createBill(0, false, 1e6);
        realHandler.borrowEnrolAndPay(0, 50_000, 6_000, 0);
        realHandler.enrol(1);
        realHandler.payFromBalance(1, 1);

        assertEq(realHandler.refusedSameBlock(), 2, "the real contract did not refuse both same-block payments");
        assertEq(realHandler.successfulPays(), 0);
        assertEq(realHandler.sameBlockBreaks(), 0, realHandler.firstBreak());
    }

    /// @dev Tries each block.number opcode in AdagBills' runtime code and keeps the one whose swap leaves enrol
    /// recording its block but lets a same-block payment through. Exactly one must qualify, so a compiler change
    /// that moves or merges the guard fails here instead of weakening the control.
    function _guardlessCode() internal returns (bytes memory patched) {
        bytes memory code = address(adag).code;
        uint256 hits;
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            // PUSH1 to PUSH32 carry 1 to 32 bytes of data, which are not opcodes.
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            if (op != 0x43) continue;
            bytes memory candidate = bytes.concat(code);
            candidate[i] = 0x46;
            if (_letsSameBlockPayThrough(candidate)) {
                patched = candidate;
                hits++;
            }
        }
        assertEq(hits, 1, "expected exactly one block.number read whose swap removes only the guard");
    }

    function _letsSameBlockPayThrough(bytes memory candidate) internal returns (bool through) {
        uint256 snapshot = vm.snapshotState();
        vm.etch(GUARDLESS, candidate);
        AdagBills variant = AdagBills(GUARDLESS);
        vm.prank(makeAddr("payee 1"));
        uint256 id = variant.createBill(ArcMainnet.USDC, 1e6, 0, "");
        vm.prank(PAYER);
        variant.enrol();
        if (variant.enrolledAt(PAYER) == block.number) {
            vm.prank(PAYER);
            USDC.approve(GUARDLESS, 1e6);
            vm.prank(PAYER);
            try variant.pay(id) {
                through = true;
            } catch {}
        }
        vm.revertToState(snapshot);
    }
}
