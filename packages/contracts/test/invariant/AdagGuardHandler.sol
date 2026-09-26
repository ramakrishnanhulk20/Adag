// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagGuard} from "../../src/AdagGuard.sol";
import {MarketParams} from "../../src/interfaces/IMorphoMinimal.sol";
import {ArcMainnet} from "../utils/ArcMainnet.sol";
import {GuardFixture} from "../AdagGuard.t.sol";

// Drives AdagGuard with random real actions on an Arc mainnet fork: rules set and cleared, approvals, Morpho
// borrowing and repaying, price moves (zero included), time passing, and protect from any of six callers. Every
// action catches its own failures. A rule broken inside an action is counted and its first reason kept; the
// invariant test asserts the counts stay at zero.
contract AdagGuardHandler is GuardFixture {
    address[3] internal borrowers;
    address[3] internal strangers;

    uint256 internal usdcBasePrice;
    uint256 internal eurcBasePrice;
    uint256 internal usdcPriceBps = 10_000;
    uint256 internal eurcPriceBps = 10_000;

    mapping(address borrower => mapping(address token => uint256)) public lastApproved;
    mapping(address borrower => mapping(address token => uint256)) public pulledSinceApproval;
    mapping(address borrower => mapping(address token => uint256)) public totalApproved;
    mapping(address borrower => mapping(address token => uint256)) public totalPulled;
    mapping(address borrower => mapping(address token => bool)) public everUnlimited;
    mapping(address borrower => mapping(bytes32 marketId => bool)) public ghostRule;

    uint256 public identityBreaks;
    uint256 public debtBreaks;
    uint256 public revertBreaks;
    uint256 public ruleBreaks;
    string public firstBreak;

    uint256 public protectCalls;
    uint256 public protectActs;
    uint256 public zeroPriceActs;

    constructor(AdagGuard guard_, address[3] memory borrowers_, address[3] memory strangers_) {
        guard = guard_;
        borrowers = borrowers_;
        strangers = strangers_;
        usdcBasePrice = oraclePrice(MARKET_USDC);
        eurcBasePrice = oraclePrice(MARKET_EURC);
    }

    function setRule(uint256 who, bool eurc, uint256 triggerBps, uint256 targetBps, uint256 expirySeed) external {
        _syncMocks();
        address b = borrowers[who % 3];
        bytes32 marketId = _market(eurc);
        triggerBps = bound(triggerBps, 2000, 8599);
        targetBps = bound(targetBps, 100, triggerBps - 1);
        uint64 expiry = expirySeed % 4 == 0 ? uint64(block.timestamp + bound(expirySeed, 1 hours, 10 days)) : 0;

        vm.prank(b);
        try guard.setRule(marketId, uint64(triggerBps * 1e14), uint64(targetBps * 1e14), expiry) {
            ghostRule[b][marketId] = true;
        } catch {
            _break(ruleBreaks++, "a valid rule was refused");
        }
    }

    function clearRule(uint256 who, bool eurc) external {
        _syncMocks();
        address b = borrowers[who % 3];
        bytes32 marketId = _market(eurc);
        vm.prank(b);
        try guard.clearRule(marketId) {
            if (!ghostRule[b][marketId]) _break(ruleBreaks++, "cleared a rule that did not exist");
            ghostRule[b][marketId] = false;
        } catch {
            if (ghostRule[b][marketId]) _break(ruleBreaks++, "could not clear an existing rule");
        }
    }

    function approve(uint256 who, bool eurc, uint256 amount) external {
        _syncMocks();
        address b = borrowers[who % 3];
        IERC20 token = tokenOf(_market(eurc));
        amount = amount % 7 == 0 ? type(uint256).max : bound(amount, 0, 5_000e6);
        vm.prank(b);
        token.approve(address(guard), amount);
        lastApproved[b][address(token)] = amount;
        pulledSinceApproval[b][address(token)] = 0;
        if (amount == type(uint256).max) everUnlimited[b][address(token)] = true;
        else totalApproved[b][address(token)] += amount;
    }

    function borrow(uint256 who, bool eurc, uint256 collateral, uint256 ltvBps) external {
        _syncMocks();
        address b = borrowers[who % 3];
        bytes32 marketId = _market(eurc);
        MarketParams memory p = paramsOf(marketId);
        collateral = bound(collateral, 1e4, 1e7);
        uint256 amount = collateral * oraclePrice(marketId) / 1e36 * bound(ltvBps, 1000, 8000) / 10_000;
        if (amount == 0) return;
        deal(ArcMainnet.CIRBTC, b, CIRBTC.balanceOf(b) + collateral);
        vm.startPrank(b);
        CIRBTC.approve(ArcMainnet.MORPHO, collateral);
        MORPHO.supplyCollateral(p, collateral, b, "");
        try MORPHO.borrow(p, amount, 0, b, b) {} catch {}
        vm.stopPrank();
    }

    function repay(uint256 who, bool eurc, uint256 fractionBps) external {
        _syncMocks();
        address b = borrowers[who % 3];
        bytes32 marketId = _market(eurc);
        MarketParams memory p = paramsOf(marketId);
        (, uint128 shares,) = MORPHO.position(marketId, b);
        uint256 part = uint256(shares) * bound(fractionBps, 1, 10_000) / 10_000;
        if (part == 0) return;
        IERC20 token = tokenOf(marketId);
        vm.startPrank(b);
        token.approve(ArcMainnet.MORPHO, type(uint256).max);
        try MORPHO.repay(p, 0, part, b, "") {} catch {}
        token.approve(ArcMainnet.MORPHO, 0);
        vm.stopPrank();
    }

    // One move in twenty-five sets the price to zero.
    function movePrice(bool eurc, uint256 bps) external {
        bps = bound(bps, 0, 20_000);
        if (bps < 800) bps = 0;
        if (eurc) eurcPriceBps = bps;
        else usdcPriceBps = bps;
        _syncMocks();
    }

    function passTime(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 1, 7 days);
        vm.warp(block.timestamp + secondsAhead);
        vm.roll(block.number + secondsAhead / 2 + 1);
        _syncMocks();
    }

    function protect(uint256 callerSeed, uint256 who, bool eurc) external {
        _syncMocks();
        address b = borrowers[who % 3];
        address caller = callerSeed % 2 == 0 ? strangers[callerSeed % 3] : borrowers[callerSeed % 3];
        bytes32 marketId = _market(eurc);
        IERC20 token = tokenOf(marketId);
        MORPHO.accrueInterest(paramsOf(marketId));

        uint256[3] memory debts;
        for (uint256 i; i < 3; ++i) {
            debts[i] = debtUp(marketId, borrowers[i]);
        }
        uint256 wallet = token.balanceOf(b);
        uint256 guardBalance = token.balanceOf(address(guard));
        protectCalls++;

        vm.prank(caller);
        try guard.protect(b, marketId) returns (uint256 repaid) {
            uint256 walletAfter = token.balanceOf(b);
            if (walletAfter > wallet || wallet - walletAfter != repaid) {
                _break(identityBreaks++, "pulled differs from repaid");
            }
            if (token.balanceOf(address(guard)) != guardBalance) _break(identityBreaks++, "guard balance changed");
            for (uint256 i; i < 3; ++i) {
                if (debtUp(marketId, borrowers[i]) > debts[i]) _break(debtBreaks++, "protect raised a debt");
            }
            pulledSinceApproval[b][address(token)] += repaid;
            totalPulled[b][address(token)] += repaid;
            if (repaid > 0) {
                protectActs++;
                if ((eurc ? eurcPriceBps : usdcPriceBps) == 0) zeroPriceActs++;
            }
        } catch (bytes memory reason) {
            _break(revertBreaks++, string.concat("protect reverted: ", vm.toString(reason)));
        }
    }

    function borrowerAt(uint256 i) external view returns (address) {
        return borrowers[i];
    }

    function strangerAt(uint256 i) external view returns (address) {
        return strangers[i];
    }

    function _syncMocks() internal {
        mockPrice(MARKET_USDC, usdcBasePrice * usdcPriceBps / 10_000);
        mockPrice(MARKET_EURC, eurcBasePrice * eurcPriceBps / 10_000);
    }

    function _market(bool eurc) internal pure returns (bytes32) {
        return eurc ? MARKET_EURC : MARKET_USDC;
    }

    function _break(uint256 countBefore, string memory reason) internal {
        if (countBefore == 0 && bytes(firstBreak).length == 0) firstBreak = reason;
    }
}
