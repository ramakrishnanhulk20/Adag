// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../../src/AdagBills.sol";
import {IOracleMinimal} from "../../src/interfaces/IOracleMinimal.sol";
import {AdagFixture} from "../utils/AdagFixture.sol";
import {ArcMainnet} from "../utils/ArcMainnet.sol";
import {IMemo, IMulticall3From} from "../utils/ArcInterfaces.sol";

/// @notice Drives AdagBills with random real actions on an Arc mainnet fork and keeps a ghost copy of what should
/// be true. Every action catches its own failures, so a refused payment is data, not a stopped run. A rule broken
/// inside an action is counted and its first reason kept; the invariant test asserts the counts stay at zero.
contract AdagHandler is AdagFixture {
    struct Ghost {
        address payee;
        address currency;
        uint256 amount;
        AdagBills.Status status;
        uint256 timesPaid;
    }

    struct Pair {
        uint256 shares;
        uint256 collateral;
    }

    address[4] internal payees;
    address[2] internal payers;
    mapping(uint256 id => Ghost) internal ghosts;
    /// @dev The position at the last payment whose 40% check passed, or at the last enrolment, per payer and market.
    mapping(address payer => mapping(bytes32 marketId => Pair)) internal lastAcceptedOrEnrolled;
    mapping(address payer => uint256 blockNumber) internal lastEnrolBlock;

    uint256 public created;
    uint256 public paidUsdc;
    uint256 public paidEurc;

    uint256 public statusBreaks;
    uint256 public creditBreaks;
    uint256 public bookkeepingBreaks;
    uint256 public lineBreaks;
    uint256 public idBreaks;
    uint256 public decisionBreaks;
    uint256 public dominanceBreaks;
    uint256 public sameBlockBreaks;
    string public firstBreak;

    uint256 public successfulPays;
    uint256 public checkedPays;
    uint256 public refusedNotOpen;
    uint256 public refusedOverLine;
    uint256 public refusedOther;
    uint256 public reuseAttempts;
    uint256 public enrolments;
    uint256 public refusedSameBlock;

    /// @dev The real oracle prices at deploy, and a per-market factor in basis points that price moves adjust.
    uint256 internal usdcBasePrice;
    uint256 internal eurcBasePrice;
    uint256 internal usdcPriceBps = 10_000;
    uint256 internal eurcPriceBps = 10_000;

    constructor(AdagBills adag_, address[4] memory payees_, address[2] memory payers_) {
        adag = adag_;
        payees = payees_;
        payers = payers_;
        usdcBasePrice = IOracleMinimal(paramsOf(ArcMainnet.MARKET_USDC).oracle).price();
        eurcBasePrice = IOracleMinimal(paramsOf(ArcMainnet.MARKET_EURC).oracle).price();
    }

    function createBill(uint256 payeeSeed, bool eurc, uint256 amount) external {
        _syncMocks();
        address payee = payees[payeeSeed % payees.length];
        address currency = eurc ? ArcMainnet.EURC : ArcMainnet.USDC;
        amount = _bound(amount, 1e4, 3e6);

        vm.prank(payee);
        uint256 id = adag.createBill(currency, amount, 0, "INV");

        created++;
        if (id != created) {
            idBreaks++;
            _note("bill id is not the next number");
        }
        ghosts[id] = Ghost(payee, currency, amount, AdagBills.Status.Open, 0);
    }

    function voidBill(uint256 idSeed) external {
        _syncMocks();
        if (created == 0) return;
        uint256 id = 1 + idSeed % created;
        Ghost storage g = ghosts[id];

        vm.prank(g.payee);
        try adag.voidBill(id) {
            if (g.status != AdagBills.Status.Open) {
                statusBreaks++;
                _note("a bill that was not open was voided");
            }
            g.status = AdagBills.Status.Void;
        } catch {
            if (g.status == AdagBills.Status.Open) {
                statusBreaks++;
                _note("the payee could not void an open bill");
            }
        }
    }

    function payFromBalance(uint256 idSeed, uint256 payerSeed) external {
        _syncMocks();
        if (created == 0) return;
        uint256 id = _pickBill(idSeed);
        _pay(id, payers[payerSeed % payers.length], cashCalls(id));
    }

    function payFromLoan(uint256 idSeed, uint256 payerSeed, uint256 ltvBps) external {
        _syncMocks();
        if (created == 0) return;
        uint256 id = _pickBill(idSeed);
        address payer = payers[payerSeed % payers.length];
        Ghost storage g = ghosts[id];
        ltvBps = _bound(ltvBps, 500, 6000);
        bytes32 marketId = _marketOf(g.currency);
        uint256 price = IOracleMinimal(paramsOf(marketId).oracle).price();
        uint256 denominator = price * ltvBps * 1e14;
        uint256 collateral = (g.amount * 1e36 * 1e18 + denominator - 1) / denominator;
        if (collateral == 0 || collateral > CIRBTC.balanceOf(payer)) return;
        _pay(id, payer, loanCalls(payer, id, collateral, g.amount));
    }

    function borrowOutsideAdag(uint256 payerSeed, bool eurc, uint256 collateral, uint256 ltvBps) external {
        _syncMocks();
        address payer = payers[payerSeed % payers.length];
        bytes32 marketId = eurc ? ArcMainnet.MARKET_EURC : ArcMainnet.MARKET_USDC;
        collateral = _bound(collateral, 1_000, 100_000);
        if (collateral > CIRBTC.balanceOf(payer)) return;
        uint256 borrow = borrowForLtv(marketId, collateral, _bound(ltvBps, 100, 7000) * 1e14);
        if (borrow == 0) return;
        tryBatch(payer, pledgeAndBorrowCalls(payer, marketId, collateral, borrow));
    }

    function repayPart(uint256 payerSeed, bool eurc, uint256 fractionBps) external {
        _syncMocks();
        address payer = payers[payerSeed % payers.length];
        bytes32 marketId = eurc ? ArcMainnet.MARKET_EURC : ArcMainnet.MARKET_USDC;
        (, uint128 shares,) = MORPHO.position(marketId, payer);
        if (shares == 0) return;
        uint256 part = uint256(shares) * _bound(fractionBps, 1, 10_000) / 10_000;
        if (part == 0) part = 1;
        tryBatch(payer, repaySharesCalls(payer, marketId, part));
    }

    // Time passing is also the only way to a new block, which a payer needs after enrolling.
    function passTime(uint256 secondsAhead) external {
        vm.warp(block.timestamp + _bound(secondsAhead, 1, 2 days));
        vm.roll(block.number + 1);
        _syncMocks();
    }

    function enrol(uint256 payerSeed) external {
        _syncMocks();
        address payer = payers[payerSeed % payers.length];
        vm.prank(payer);
        adag.enrol();
        enrolments++;
        (, uint128 usdcShares, uint128 usdcCollateral) = MORPHO.position(ArcMainnet.MARKET_USDC, payer);
        (, uint128 eurcShares, uint128 eurcCollateral) = MORPHO.position(ArcMainnet.MARKET_EURC, payer);
        _noteEnrolment(payer, Pair(usdcShares, usdcCollateral), Pair(eurcShares, eurcCollateral));
    }

    /// @dev The one-transaction path C32 forbids: borrow past the line, enrol the new debt, and pay with it.
    function borrowEnrolAndPay(uint256 payerSeed, uint256 collateral, uint256 ltvBps, uint256 idSeed) external {
        _syncMocks();
        if (created == 0) return;
        address payer = payers[payerSeed % payers.length];
        collateral = _bound(collateral, 1_000, 100_000);
        if (collateral > CIRBTC.balanceOf(payer)) return;
        uint256 borrow = borrowForLtv(ArcMainnet.MARKET_USDC, collateral, _bound(ltvBps, 4_100, 7_000) * 1e14);
        if (borrow == 0) return;
        IMulticall3From.Call3[] memory enrolCall = new IMulticall3From.Call3[](1);
        enrolCall[0] = call3(address(adag), abi.encodeCall(AdagBills.enrol, ()));
        uint256 id = _pickBill(idSeed);
        _pay(
            id,
            payer,
            concat(concat(pledgeAndBorrowCalls(payer, ArcMainnet.MARKET_USDC, collateral, borrow), enrolCall), cashCalls(id))
        );
    }

    function movePrice(bool eurc, uint256 moveBps) external {
        uint256 factor = 10_000 + _bound(moveBps, 0, 6_000) - 3_000;
        if (eurc) eurcPriceBps = eurcPriceBps * factor / 10_000;
        else usdcPriceBps = usdcPriceBps * factor / 10_000;
        _syncMocks();
    }

    /// @dev The backend-gate bypass, attempted at random: close outside Adag, re-pledge between a tenth and double
    /// the recorded collateral, borrow back exactly the recorded share count, then pay a bill.
    function reuseRecordedShares(uint256 payerSeed, bool eurc, uint256 collateralBps, uint256 idSeed) external {
        _syncMocks();
        if (created == 0) return;
        address payer = payers[payerSeed % payers.length];
        bytes32 marketId = eurc ? ArcMainnet.MARKET_EURC : ArcMainnet.MARKET_USDC;
        Pair memory recorded = _recorded(payer, marketId);
        if (recorded.shares == 0) return;

        (, uint128 liveShares,) = MORPHO.position(marketId, payer);
        if (liveShares != 0) {
            (bool closed,) = tryBatch(payer, closeLoanCalls(payer, marketId));
            if (!closed) return;
        }
        uint256 collateral = recorded.collateral * _bound(collateralBps, 1_000, 20_000) / 10_000;
        if (collateral == 0) collateral = 1;
        if (collateral > CIRBTC.balanceOf(payer)) return;

        reuseAttempts++;
        uint256 id = _pickBill(idSeed);
        _pay(
            id,
            payer,
            concat(
                concat(pledgeCalls(payer, marketId, collateral), borrowSharesCalls(payer, marketId, recorded.shares)),
                cashCalls(id)
            )
        );
    }

    function ghostOf(uint256 id) external view returns (Ghost memory) {
        return ghosts[id];
    }

    function payeeAt(uint256 i) external view returns (address) {
        return payees[i];
    }

    function _pay(uint256 id, address payer, IMulticall3From.Call3[] memory calls) internal {
        Ghost storage g = ghosts[id];
        Pair memory usdcBefore = _recorded(payer, ArcMainnet.MARKET_USDC);
        Pair memory eurcBefore = _recorded(payer, ArcMainnet.MARKET_EURC);
        uint256 payeeBefore = IERC20(g.currency).balanceOf(g.payee);

        vm.recordLogs();
        (bool ok, bytes memory ret) = tryBatch(payer, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        if (!ok) {
            if (g.status != AdagBills.Status.Open) refusedNotOpen++;
            else if (_isAdagError(ret, AdagBills.LtvAboveLimit.selector)) refusedOverLine++;
            else if (_isAdagError(ret, AdagBills.EnrolledThisBlock.selector)) refusedSameBlock++;
            else refusedOther++;
            if (adag.bill(id).status != g.status) {
                statusBreaks++;
                _note("a refused payment changed the bill");
            }
            return;
        }
        successfulPays++;
        // Every batch here that enrols does so before its payment, so an enrolment in the logs came first.
        _noteEnrolmentInLogs(logs, payer);
        if (lastEnrolBlock[payer] == block.number) {
            sameBlockBreaks++;
            _note("a payment went through in the block of the payer's enrolment");
        }
        if (g.status != AdagBills.Status.Open) {
            statusBreaks++;
            _note("a bill that was not open was paid");
        }
        g.status = AdagBills.Status.Paid;
        if (++g.timesPaid > 1) {
            statusBreaks++;
            _note("a bill was paid twice");
        }

        if (IERC20(g.currency).balanceOf(g.payee) - payeeBefore != g.amount) {
            creditBreaks++;
            _note("payee credit differs from the bill amount");
        }
        if (g.currency == ArcMainnet.USDC) paidUsdc += g.amount;
        else paidEurc += g.amount;

        bool checkedUsdc = _checkAfterPay(ArcMainnet.MARKET_USDC, payer, usdcBefore, logs);
        bool checkedEurc = _checkAfterPay(ArcMainnet.MARKET_EURC, payer, eurcBefore, logs);
        if (checkedUsdc || checkedEurc) checkedPays++;
    }

    function _checkAfterPay(bytes32 marketId, address payer, Pair memory before, Vm.Log[] memory logs)
        internal
        returns (bool checked)
    {
        (, uint128 shares, uint128 collateral) = MORPHO.position(marketId, payer);
        Pair memory recorded = _recorded(payer, marketId);
        if (recorded.shares != shares || recorded.collateral != collateral) {
            bookkeepingBreaks++;
            _note("the recorded position differs from the live one after a payment");
        }

        checked = _checkedInLogs(logs, payer, marketId);
        bool ruleSaysCheck = shares != 0 && (shares > before.shares || collateral < before.collateral);
        if (checked != ruleSaysCheck) {
            decisionBreaks++;
            _note("whether the payment was checked differs from the rule");
        }
        // Adag accrued interest in this same call when it checked, so the stored totals are current here.
        if (checked && independentDebt(marketId, payer) > independentLine(marketId, payer)) {
            lineBreaks++;
            _note("a checked payment left the loan above 40%");
        }

        if (checked) {
            lastAcceptedOrEnrolled[payer][marketId] = Pair(shares, collateral);
        } else if (shares != 0) {
            Pair memory accepted = lastAcceptedOrEnrolled[payer][marketId];
            if (shares > accepted.shares || collateral < accepted.collateral) {
                dominanceBreaks++;
                _note("an unchecked position with debt is less safe than the last one accepted or enrolled");
            }
        }
    }

    function _noteEnrolment(address payer, Pair memory usdc, Pair memory eurc) internal {
        lastEnrolBlock[payer] = block.number;
        lastAcceptedOrEnrolled[payer][ArcMainnet.MARKET_USDC] = usdc;
        lastAcceptedOrEnrolled[payer][ArcMainnet.MARKET_EURC] = eurc;
    }

    // An enrolment inside a batch is only visible through its event, since the batch moves the position after it.
    function _noteEnrolmentInLogs(Vm.Log[] memory logs, address payer) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.Enrolled.selector
                    && logs[i].topics[1] == bytes32(uint256(uint160(payer)))
            ) {
                (uint256 usdcShares, uint256 usdcCollateral, uint256 eurcShares, uint256 eurcCollateral) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                _noteEnrolment(payer, Pair(usdcShares, usdcCollateral), Pair(eurcShares, eurcCollateral));
            }
        }
    }

    function _recorded(address payer, bytes32 marketId) internal view returns (Pair memory p) {
        (p.shares, p.collateral) = adag.seenPosition(payer, marketId);
    }

    function _checkedInLogs(Vm.Log[] memory logs, address payer, bytes32 marketId) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(adag) && logs[i].topics[0] == AdagBills.DebtRecorded.selector
                    && logs[i].topics[1] == bytes32(uint256(uint160(payer))) && logs[i].topics[2] == marketId
            ) {
                (,, bool checked) = abi.decode(logs[i].data, (uint256, uint256, bool));
                return checked;
            }
        }
        return false;
    }

    // Mocks may outlive an invariant run while this contract's storage does not. Re-applying them from storage
    // on every action makes each run see the prices and fresh feeds its own actions chose.
    function _syncMocks() internal {
        mockFreshFeed(ArcMainnet.BTC_USD_FEED);
        mockFreshFeed(ArcMainnet.EUR_USD_FEED);
        mockPrice(ArcMainnet.MARKET_USDC, usdcBasePrice * usdcPriceBps / 10_000);
        mockPrice(ArcMainnet.MARKET_EURC, eurcBasePrice * eurcPriceBps / 10_000);
    }

    // Three picks in four go to the next open bill so payments keep happening; the fourth takes any bill, so
    // paying a paid or voided bill keeps being attempted.
    function _pickBill(uint256 idSeed) internal view returns (uint256 id) {
        id = 1 + idSeed % created;
        if (idSeed % 4 == 0) return id;
        for (uint256 i; i < created; ++i) {
            uint256 candidate = 1 + (id - 1 + i) % created;
            if (ghosts[candidate].status == AdagBills.Status.Open) return candidate;
        }
    }

    function _isAdagError(bytes memory ret, bytes4 selector) internal view returns (bool) {
        if (ret.length < 4 || bytes4(ret) != IMemo.MemoFailed.selector) return false;
        bytes memory inner = abi.decode(this.dropSelector(ret), (bytes));
        return inner.length >= 4 && bytes4(inner) == selector;
    }

    function _marketOf(address currency) internal pure returns (bytes32) {
        return currency == ArcMainnet.USDC ? ArcMainnet.MARKET_USDC : ArcMainnet.MARKET_EURC;
    }

    function _note(string memory reason) internal {
        if (bytes(firstBreak).length == 0) firstBreak = reason;
    }
}
