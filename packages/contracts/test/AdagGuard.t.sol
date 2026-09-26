// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Unit tests for AdagGuard on an Arc mainnet fork, against the real Morpho markets, cirBTC, USDC and EURC.
// Positions are built in each test with dealt tokens; prices move with vm.mockCall on the market oracle.
// Not covered here: random inputs (AdagGuardFuzz), random sequences (test/invariant), liquidations racing a
// protect, token pauses and blocklists, the keeper, and real signed transactions.

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagGuard} from "../src/AdagGuard.sol";
import {MarketParams} from "../src/interfaces/IMorphoMinimal.sol";
import {IOracleMinimal} from "../src/interfaces/IOracleMinimal.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";

// The Morpho calls a borrower makes, copied from morpho-blue v1.0.0 IMorpho.sol.
interface IMorphoTest {
    function idToMarketParams(bytes32 id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    function borrow(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function accrueInterest(MarketParams memory marketParams) external;

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
}

abstract contract GuardFixture is Test {
    IERC20 internal constant USDC = IERC20(ArcMainnet.USDC);
    IERC20 internal constant EURC = IERC20(ArcMainnet.EURC);
    IERC20 internal constant CIRBTC = IERC20(ArcMainnet.CIRBTC);
    IMorphoTest internal constant MORPHO = IMorphoTest(ArcMainnet.MORPHO);
    bytes32 internal constant MARKET_USDC = ArcMainnet.MARKET_USDC;
    bytes32 internal constant MARKET_EURC = ArcMainnet.MARKET_EURC;
    bytes32 internal constant PROTECTED_TOPIC = keccak256("Protected(address,bytes32,uint256,uint256,uint256)");

    // 0.1 cirBTC, a few thousand dollars of borrowing power in either market.
    uint256 internal constant COLLATERAL = 1e7;

    AdagGuard internal guard;

    function setUp() public virtual {
        assertEq(block.chainid, ArcMainnet.CHAIN_ID, "not an Arc mainnet fork");
        guard = new AdagGuard();
        vm.label(address(guard), "AdagGuard");
        vm.label(ArcMainnet.MORPHO, "Morpho");
        vm.label(ArcMainnet.USDC, "USDC");
        vm.label(ArcMainnet.EURC, "EURC");
        vm.label(ArcMainnet.CIRBTC, "cirBTC");
    }

    function paramsOf(bytes32 marketId) internal view returns (MarketParams memory p) {
        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = MORPHO.idToMarketParams(marketId);
    }

    function tokenOf(bytes32 marketId) internal pure returns (IERC20) {
        return marketId == MARKET_USDC ? USDC : EURC;
    }

    // Sets the wallet's loan token balance. Native USDC has 18 decimals and its ERC-20 face reads it as 6.
    function setBalance(address who, bytes32 marketId, uint256 amount) internal {
        if (marketId == MARKET_USDC) vm.deal(who, amount * 1e12);
        else deal(ArcMainnet.EURC, who, amount);
    }

    function oraclePrice(bytes32 marketId) internal view returns (uint256) {
        return IOracleMinimal(paramsOf(marketId).oracle).price();
    }

    function mockPrice(bytes32 marketId, uint256 newPrice) internal {
        vm.mockCall(paramsOf(marketId).oracle, abi.encodeWithSelector(IOracleMinimal.price.selector), abi.encode(newPrice));
    }

    // Pledges `collateral` and borrows to `ltvWad` of its value at the live price, straight through Morpho.
    function openLoan(address who, bytes32 marketId, uint256 collateral, uint256 ltvWad) internal returns (uint256 borrowed) {
        MarketParams memory p = paramsOf(marketId);
        deal(ArcMainnet.CIRBTC, who, CIRBTC.balanceOf(who) + collateral);
        borrowed = collateral * oraclePrice(marketId) / 1e36 * ltvWad / 1e18;
        vm.startPrank(who);
        CIRBTC.approve(ArcMainnet.MORPHO, collateral);
        MORPHO.supplyCollateral(p, collateral, who, "");
        MORPHO.borrow(p, borrowed, 0, who, who);
        vm.stopPrank();
    }

    // Mocks the oracle so the borrower's live loan-to-value becomes about `ltvWad`.
    function moveToLtv(address who, bytes32 marketId, uint256 ltvWad) internal {
        MORPHO.accrueInterest(paramsOf(marketId));
        (,, uint128 collateral) = MORPHO.position(marketId, who);
        mockPrice(marketId, debtUp(marketId, who) * 1e36 * 1e18 / (uint256(collateral) * ltvWad));
    }

    function approveGuard(address who, bytes32 marketId, uint256 amount) internal {
        vm.prank(who);
        tokenOf(marketId).approve(address(guard), amount);
    }

    function setRule(address who, bytes32 marketId, uint256 triggerWad, uint256 targetWad) internal {
        vm.prank(who);
        guard.setRule(marketId, uint64(triggerWad), uint64(targetWad), 0);
    }

    // The helpers below restate Morpho's formulas in plain integer maths, apart from AdagGuard, so tests judge
    // its answers against code it does not share. They read stored totals, so callers accrue interest first.

    function debtUp(bytes32 marketId, address who) internal view returns (uint256) {
        (, uint128 shares,) = MORPHO.position(marketId, who);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        uint256 d = uint256(totalShares) + 1e6;
        return (uint256(shares) * (uint256(totalAssets) + 1) + d - 1) / d;
    }

    function debtDown(bytes32 marketId, address who) internal view returns (uint256) {
        (, uint128 shares,) = MORPHO.position(marketId, who);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        return uint256(shares) * (uint256(totalAssets) + 1) / (uint256(totalShares) + 1e6);
    }

    function collateralValue(bytes32 marketId, address who) internal view returns (uint256) {
        (,, uint128 collateral) = MORPHO.position(marketId, who);
        return uint256(collateral) * oraclePrice(marketId) / 1e36;
    }

    function ltvOf(bytes32 marketId, address who) internal view returns (uint256) {
        uint256 debt = debtUp(marketId, who);
        if (debt == 0) return 0;
        uint256 value = collateralValue(marketId, who);
        if (value == 0) return type(uint256).max;
        return (debt * 1e18 + value - 1) / value;
    }

    function countProtected(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(guard) && logs[i].topics[0] == PROTECTED_TOPIC) ++n;
        }
    }

    function assertGuardHoldsNothing() internal view {
        assertEq(USDC.balanceOf(address(guard)), 0, "guard holds USDC");
        assertEq(EURC.balanceOf(address(guard)), 0, "guard holds EURC");
        assertEq(CIRBTC.balanceOf(address(guard)), 0, "guard holds cirBTC");
        assertEq(USDC.allowance(address(guard), ArcMainnet.MORPHO), 0, "guard left a USDC approval");
        assertEq(EURC.allowance(address(guard), ArcMainnet.MORPHO), 0, "guard left an EURC approval");
    }
}

contract AdagGuardTest is GuardFixture {
    uint256 internal constant TRIGGER = 0.7e18;
    uint256 internal constant TARGET = 0.6e18;

    address internal borrower = makeAddr("borrower");
    address internal stranger = makeAddr("stranger");

    event RuleSet(address indexed borrower, bytes32 indexed marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry);
    event RuleCleared(address indexed borrower, bytes32 indexed marketId);
    event Protected(
        address indexed borrower, bytes32 indexed marketId, uint256 repaid, uint256 ltvBeforeWad, uint256 ltvAfterWad
    );

    struct Snap {
        uint256 wallet;
        uint256 allowance;
        uint256 debt;
        uint256 collateral;
    }

    function snap(bytes32 marketId) internal view returns (Snap memory s) {
        s.wallet = tokenOf(marketId).balanceOf(borrower);
        s.allowance = tokenOf(marketId).allowance(borrower, address(guard));
        s.debt = debtUp(marketId, borrower);
        (,, uint128 c) = MORPHO.position(marketId, borrower);
        s.collateral = c;
    }

    // A loan at 50%, a 70/60 rule, a full approval, then the price falls until the loan sits at 75%.
    function armed(bytes32 marketId) internal {
        openLoan(borrower, marketId, COLLATERAL, 0.5e18);
        setRule(borrower, marketId, TRIGGER, TARGET);
        approveGuard(borrower, marketId, type(uint256).max);
        moveToLtv(borrower, marketId, 0.75e18);
    }

    function test_setRule_storesEmitsAndAddsHolder() public {
        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.expectEmit(address(guard));
        emit RuleSet(borrower, MARKET_USDC, 0.7e18, 0.6e18, expiry);
        vm.prank(borrower);
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, expiry);

        AdagGuard.Rule memory r = guard.ruleOf(borrower, MARKET_USDC);
        assertEq(r.triggerWad, 0.7e18);
        assertEq(r.targetWad, 0.6e18);
        assertEq(r.expiry, expiry);
        assertEq(guard.holderCount(), 1);
        assertEq(guard.holders(0, 10)[0], borrower);
    }

    function test_setRule_overwriteAndSecondMarketKeepOneHolder() public {
        setRule(borrower, MARKET_USDC, 0.7e18, 0.6e18);
        vm.expectEmit(address(guard));
        emit RuleSet(borrower, MARKET_USDC, 0.8e18, 0.5e18, 0);
        setRule(borrower, MARKET_USDC, 0.8e18, 0.5e18);
        setRule(borrower, MARKET_EURC, 0.75e18, 0.65e18);

        assertEq(guard.ruleOf(borrower, MARKET_USDC).triggerWad, 0.8e18);
        assertEq(guard.ruleOf(borrower, MARKET_USDC).targetWad, 0.5e18);
        assertEq(guard.ruleOf(borrower, MARKET_EURC).triggerWad, 0.75e18);
        assertEq(guard.holderCount(), 1, "one borrower listed twice");
    }

    function test_setRule_refusesUnknownMarket() public {
        bytes32 bogus = keccak256("not a market");
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.BadMarket.selector, bogus));
        vm.prank(borrower);
        guard.setRule(bogus, 0.7e18, 0.6e18, 0);
    }

    function test_setRule_refusesZeroTarget() public {
        vm.expectRevert(AdagGuard.ZeroTarget.selector);
        vm.prank(borrower);
        guard.setRule(MARKET_USDC, 0.7e18, 0, 0);
    }

    function test_setRule_refusesTargetAtOrAboveTrigger() public {
        vm.startPrank(borrower);
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.TargetNotBelowTrigger.selector, uint64(0.6e18), uint64(0.6e18)));
        guard.setRule(MARKET_USDC, 0.6e18, 0.6e18, 0);
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.TargetNotBelowTrigger.selector, uint64(0.65e18), uint64(0.6e18)));
        guard.setRule(MARKET_USDC, 0.6e18, 0.65e18, 0);
        // A zero trigger can only fail here, since the target must be above zero.
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.TargetNotBelowTrigger.selector, uint64(1), uint64(0)));
        guard.setRule(MARKET_USDC, 0, 1, 0);
        vm.stopPrank();
    }

    function test_setRule_refusesTriggerAtOrAboveLiquidation() public {
        uint256 lltv = paramsOf(MARKET_EURC).lltv;
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.TriggerNotBelowLiquidation.selector, uint64(lltv), lltv));
        vm.prank(borrower);
        guard.setRule(MARKET_EURC, uint64(lltv), 0.6e18, 0);
        // One unit under the line is accepted.
        setRule(borrower, MARKET_EURC, lltv - 1, 0.6e18);
    }

    function test_setRule_refusesPastOrPresentExpiry() public {
        vm.startPrank(borrower);
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.ExpiryInPast.selector, uint64(block.timestamp)));
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.ExpiryInPast.selector, uint64(block.timestamp - 1)));
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, uint64(block.timestamp - 1));
        guard.setRule(MARKET_USDC, 0.7e18, 0.6e18, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function test_clearRule_emitsAndRemovesHolderOnLastRule() public {
        setRule(borrower, MARKET_USDC, TRIGGER, TARGET);
        setRule(borrower, MARKET_EURC, TRIGGER, TARGET);

        vm.expectEmit(address(guard));
        emit RuleCleared(borrower, MARKET_USDC);
        vm.prank(borrower);
        guard.clearRule(MARKET_USDC);
        assertEq(guard.ruleOf(borrower, MARKET_USDC).triggerWad, 0);
        assertEq(guard.holderCount(), 1, "holder dropped while an EURC rule remains");

        vm.prank(borrower);
        guard.clearRule(MARKET_EURC);
        assertEq(guard.holderCount(), 0);
        assertEq(guard.holders(0, 10).length, 0);
    }

    function test_clearRule_refusesWhenNoRule() public {
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.NoRule.selector, borrower, MARKET_USDC));
        vm.prank(borrower);
        guard.clearRule(MARKET_USDC);

        setRule(borrower, MARKET_USDC, TRIGGER, TARGET);
        vm.startPrank(borrower);
        guard.clearRule(MARKET_USDC);
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.NoRule.selector, borrower, MARKET_USDC));
        guard.clearRule(MARKET_USDC);
        vm.stopPrank();
    }

    function test_onlyTheBorrowerWritesTheirRule() public {
        setRule(borrower, MARKET_USDC, TRIGGER, TARGET);

        vm.expectRevert(abi.encodeWithSelector(AdagGuard.NoRule.selector, stranger, MARKET_USDC));
        vm.prank(stranger);
        guard.clearRule(MARKET_USDC);

        // A stranger's setRule writes the stranger's own rule and nothing else.
        setRule(stranger, MARKET_USDC, 0.8e18, 0.1e18);
        AdagGuard.Rule memory r = guard.ruleOf(borrower, MARKET_USDC);
        assertEq(r.triggerWad, TRIGGER, "stranger changed the borrower's trigger");
        assertEq(r.targetWad, TARGET, "stranger changed the borrower's target");
        assertEq(guard.ruleOf(stranger, MARKET_USDC).targetWad, 0.1e18);
    }

    function test_protect_landsAtOrJustUnderTarget() public {
        armed(MARKET_USDC);
        (bool wouldAct, uint256 quoted, uint256 quotedLtv) = guard.quote(borrower, MARKET_USDC);
        Snap memory before = snap(MARKET_USDC);
        uint256 ltvBefore = ltvOf(MARKET_USDC, borrower);
        assertTrue(wouldAct);
        assertEq(quotedLtv, ltvBefore, "quote reads a different loan-to-value");

        vm.recordLogs();
        vm.prank(stranger);
        uint256 repaid = guard.protect(borrower, MARKET_USDC);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Snap memory afterwards = snap(MARKET_USDC);
        uint256 ltvAfter = ltvOf(MARKET_USDC, borrower);
        assertEq(repaid, quoted, "protect differs from quote");
        assertLe(ltvAfter, TARGET, "loan left above the target");
        assertGt(ltvAfter, TARGET - 1e12, "repaid far more than needed");
        assertEq(before.wallet - afterwards.wallet, repaid, "pulled differs from repaid");
        assertApproxEqAbs(before.debt - afterwards.debt, repaid, 1, "debt fell by a different amount");
        assertEq(afterwards.collateral, before.collateral, "collateral moved");
        assertGuardHoldsNothing();

        assertEq(countProtected(logs), 1);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(guard)) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(borrower))));
            assertEq(logs[i].topics[2], MARKET_USDC);
            (uint256 r, uint256 b, uint256 a) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            assertEq(r, repaid);
            assertEq(b, ltvBefore);
            assertEq(a, ltvAfter);
        }
    }

    function test_protect_repaysTheSmallestAmountThatLands() public {
        armed(MARKET_USDC);
        (, uint256 quoted,) = guard.quote(borrower, MARKET_USDC);

        // One unit less, paid straight to Morpho, leaves the loan above the target.
        uint256 snapshot = vm.snapshotState();
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        setBalance(address(this), MARKET_USDC, quoted);
        USDC.approve(ArcMainnet.MORPHO, quoted);
        MORPHO.repay(paramsOf(MARKET_USDC), quoted - 1, 0, borrower, "");
        assertGt(ltvOf(MARKET_USDC, borrower), TARGET, "one unit less would also have landed");
        vm.revertToState(snapshot);

        guard.protect(borrower, MARKET_USDC);
        assertLe(ltvOf(MARKET_USDC, borrower), TARGET);
    }

    function test_protect_repeatAtSamePricePullsNothing() public {
        armed(MARKET_USDC);
        guard.protect(borrower, MARKET_USDC);
        uint256 wallet = USDC.balanceOf(borrower);

        vm.recordLogs();
        assertEq(guard.protect(borrower, MARKET_USDC), 0);
        vm.warp(block.timestamp + 1 hours);
        assertEq(guard.protect(borrower, MARKET_USDC), 0, "interest alone pushed it back over the trigger");
        assertEq(countProtected(vm.getRecordedLogs()), 0);
        assertEq(USDC.balanceOf(borrower), wallet);
    }

    function test_protect_zeroPriceRepaysUpToDebtRoundedDown() public {
        armed(MARKET_USDC);
        mockPrice(MARKET_USDC, 0);
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        uint256 cap = debtDown(MARKET_USDC, borrower);
        // Twice the cap in the wallet and a max approval, so only the rounded-down debt can bind.
        setBalance(borrower, MARKET_USDC, 2 * cap);
        (bool wouldAct, uint256 quoted, uint256 ltv) = guard.quote(borrower, MARKET_USDC);
        assertTrue(wouldAct);
        assertEq(ltv, type(uint256).max);
        assertEq(quoted, cap);

        uint256 repaid = guard.protect(borrower, MARKET_USDC);
        assertEq(repaid, cap, "did not repay the rounded-down debt");
        assertLe(debtUp(MARKET_USDC, borrower), 1, "more than one unit of debt left");
        assertGuardHoldsNothing();
    }

    function test_protect_smallAllowanceRepaysOnlyTheAllowance() public {
        armed(MARKET_USDC);
        approveGuard(borrower, MARKET_USDC, 100);
        uint256 wallet = USDC.balanceOf(borrower);

        assertEq(guard.protect(borrower, MARKET_USDC), 100);
        assertEq(USDC.allowance(borrower, address(guard)), 0);
        assertEq(wallet - USDC.balanceOf(borrower), 100);
        assertGt(ltvOf(MARKET_USDC, borrower), TARGET, "100 units should not reach the target");
        assertEq(guard.protect(borrower, MARKET_USDC), 0, "pulled past a spent allowance");
    }

    function test_protect_smallBalanceRepaysOnlyTheBalance() public {
        armed(MARKET_USDC);
        setBalance(borrower, MARKET_USDC, 250);

        assertEq(guard.protect(borrower, MARKET_USDC), 250);
        assertEq(USDC.balanceOf(borrower), 0);
        assertEq(guard.protect(borrower, MARKET_USDC), 0, "pulled from an empty wallet");
        assertGuardHoldsNothing();
    }

    function test_protect_expiredRuleIsInert() public {
        openLoan(borrower, MARKET_USDC, COLLATERAL, 0.5e18);
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(borrower);
        guard.setRule(MARKET_USDC, uint64(TRIGGER), uint64(TARGET), expiry);
        approveGuard(borrower, MARKET_USDC, type(uint256).max);
        vm.warp(expiry);
        moveToLtv(borrower, MARKET_USDC, 0.8e18);
        uint256 wallet = USDC.balanceOf(borrower);

        (bool wouldAct, uint256 amount,) = guard.quote(borrower, MARKET_USDC);
        assertFalse(wouldAct);
        assertEq(amount, 0);
        assertEq(guard.protect(borrower, MARKET_USDC), 0);
        assertEq(USDC.balanceOf(borrower), wallet);
    }

    function test_protect_healthyLoanPullsNothing() public {
        openLoan(borrower, MARKET_USDC, COLLATERAL, 0.5e18);
        setRule(borrower, MARKET_USDC, TRIGGER, TARGET);
        approveGuard(borrower, MARKET_USDC, type(uint256).max);
        moveToLtv(borrower, MARKET_USDC, 0.69e18);
        Snap memory before = snap(MARKET_USDC);

        vm.recordLogs();
        vm.prank(stranger);
        assertEq(guard.protect(borrower, MARKET_USDC), 0);
        assertEq(countProtected(vm.getRecordedLogs()), 0);
        Snap memory afterwards = snap(MARKET_USDC);
        assertEq(afterwards.wallet, before.wallet);
        assertEq(afterwards.debt, before.debt);
    }

    function test_protect_noRuleOrNoDebtPullsNothing() public {
        openLoan(borrower, MARKET_USDC, COLLATERAL, 0.5e18);
        approveGuard(borrower, MARKET_USDC, type(uint256).max);
        moveToLtv(borrower, MARKET_USDC, 0.8e18);
        assertEq(guard.protect(borrower, MARKET_USDC), 0, "acted without a rule");

        setRule(stranger, MARKET_USDC, TRIGGER, TARGET);
        (bool wouldAct, uint256 amount, uint256 ltv) = guard.quote(stranger, MARKET_USDC);
        assertFalse(wouldAct);
        assertEq(amount, 0);
        assertEq(ltv, 0);
        assertEq(guard.protect(stranger, MARKET_USDC), 0, "acted on a wallet with no loan");
    }

    function test_protect_refusesUnknownMarket() public {
        bytes32 bogus = keccak256("not a market");
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.BadMarket.selector, bogus));
        guard.protect(borrower, bogus);
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.BadMarket.selector, bogus));
        guard.quote(borrower, bogus);
    }

    function test_protect_revertsWhenThePriceReverts() public {
        armed(MARKET_USDC);
        vm.mockCallRevert(paramsOf(MARKET_USDC).oracle, abi.encodeWithSelector(IOracleMinimal.price.selector), "oracle down");
        vm.expectRevert(bytes("oracle down"));
        guard.protect(borrower, MARKET_USDC);
    }

    function test_protect_eurcMarket() public {
        armed(MARKET_EURC);
        (, uint256 quoted,) = guard.quote(borrower, MARKET_EURC);
        Snap memory before = snap(MARKET_EURC);

        uint256 repaid = guard.protect(borrower, MARKET_EURC);

        assertEq(repaid, quoted);
        assertGt(repaid, 0);
        assertEq(before.wallet - EURC.balanceOf(borrower), repaid);
        assertLe(ltvOf(MARKET_EURC, borrower), TARGET);
        assertEq(USDC.balanceOf(borrower), 0, "USDC moved for an EURC loan");
        assertGuardHoldsNothing();
    }

    function test_protect_quoteMatchesAfterInterestAccrues() public {
        armed(MARKET_USDC);
        vm.warp(block.timestamp + 20 days);
        (, uint256 quoted, uint256 quotedLtv) = guard.quote(borrower, MARKET_USDC);
        MORPHO.accrueInterest(paramsOf(MARKET_USDC));
        assertEq(quotedLtv, ltvOf(MARKET_USDC, borrower), "expected interest differs from Morpho's");
        assertEq(guard.protect(borrower, MARKET_USDC), quoted);
    }

    function test_protect_strayTokensStayPut() public {
        armed(MARKET_EURC);
        deal(ArcMainnet.EURC, address(guard), 5e6);

        assertGt(guard.protect(borrower, MARKET_EURC), 0);
        assertEq(EURC.balanceOf(address(guard)), 5e6, "stray tokens were spent");
    }

    function test_protect_refusesWhenMorphoTakesLess() public {
        armed(MARKET_EURC);
        (, uint256 quoted,) = guard.quote(borrower, MARKET_EURC);
        vm.mockCall(ArcMainnet.MORPHO, abi.encodeWithSelector(IMorphoTest.repay.selector), abi.encode(quoted - 1, 0));
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.RepaidNotPulled.selector, quoted - 1, quoted));
        guard.protect(borrower, MARKET_EURC);
    }

    function test_protect_refusesWhenTokensStayInTheGuard() public {
        armed(MARKET_EURC);
        (, uint256 quoted,) = guard.quote(borrower, MARKET_EURC);
        vm.mockCall(ArcMainnet.MORPHO, abi.encodeWithSelector(IMorphoTest.repay.selector), abi.encode(quoted, 0));
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.GuardBalanceChanged.selector, 0, quoted));
        guard.protect(borrower, MARKET_EURC);
    }

    function test_protect_refusesWhenAnApprovalIsLeft() public {
        armed(MARKET_EURC);
        (, uint256 quoted,) = guard.quote(borrower, MARKET_EURC);
        vm.mockCall(ArcMainnet.MORPHO, abi.encodeWithSelector(IMorphoTest.repay.selector), abi.encode(quoted, 0));
        vm.mockCall(ArcMainnet.EURC, abi.encodeCall(IERC20.balanceOf, (address(guard))), abi.encode(0));
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.MorphoAllowanceLeft.selector, 0, quoted));
        guard.protect(borrower, MARKET_EURC);
    }

    function test_holders_pages() public {
        address[3] memory people = [makeAddr("a"), makeAddr("b"), makeAddr("c")];
        for (uint256 i; i < 3; ++i) {
            setRule(people[i], MARKET_USDC, TRIGGER, TARGET);
        }
        assertEq(guard.holderCount(), 3);
        address[] memory first = guard.holders(0, 2);
        address[] memory rest = guard.holders(2, 2);
        assertEq(first.length, 2);
        assertEq(rest.length, 1);
        assertEq(first[0], people[0]);
        assertEq(first[1], people[1]);
        assertEq(rest[0], people[2]);
        assertEq(guard.holders(3, 100).length, 0);
        assertEq(guard.holders(type(uint256).max, 100).length, 0);
        assertEq(guard.holders(0, 0).length, 0);
    }

    function test_holders_refusesPageOver100() public {
        vm.expectRevert(abi.encodeWithSelector(AdagGuard.PageTooLarge.selector, 101));
        guard.holders(0, 101);
    }

    function test_ruleOf_unknownIsZero() public view {
        AdagGuard.Rule memory r = guard.ruleOf(borrower, MARKET_USDC);
        assertEq(uint256(r.triggerWad) + r.targetWad + r.expiry, 0);
    }
}
