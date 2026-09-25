// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../../src/AdagBills.sol";
import {MarketParams} from "../../src/interfaces/IMorphoMinimal.sol";
import {IOracleMinimal} from "../../src/interfaces/IOracleMinimal.sol";
import {IChainlinkFeed} from "../../src/interfaces/IChainlinkFeed.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcMainnet} from "./ArcMainnet.sol";
import {IMemo, IMulticall3From} from "./ArcInterfaces.sol";

/// @dev The Morpho calls a payer's own batch makes, copied from morpho-blue IMorpho.sol.
interface IMorphoBorrow {
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

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

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

/// @notice Deploys AdagBills on an Arc mainnet fork and drives it the way the app will: every payment is a
/// Multicall3From batch sent by the payer's own wallet, with the pay step wrapped in Memo.
abstract contract AdagFixture is Test {
    IERC20 internal constant USDC = IERC20(ArcMainnet.USDC);
    IERC20 internal constant EURC = IERC20(ArcMainnet.EURC);
    IERC20 internal constant CIRBTC = IERC20(ArcMainnet.CIRBTC);
    IMorphoBorrow internal constant MORPHO = IMorphoBorrow(ArcMainnet.MORPHO);

    /// @dev Real mainnet balances: 5 USDC and 0.00011973 cirBTC. Tests size their amounts to fit.
    address internal constant PAYER = ArcMainnet.DEMO_WALLET;

    AdagBills internal adag;

    function setUp() public virtual {
        assertEq(block.chainid, ArcMainnet.CHAIN_ID, "not an Arc mainnet fork");
        adag = new AdagBills();

        vm.label(address(adag), "AdagBills");
        vm.label(ArcMainnet.MORPHO, "Morpho");
        vm.label(ArcMainnet.MEMO, "Memo");
        vm.label(ArcMainnet.MULTICALL3_FROM, "Multicall3From");
        vm.label(ArcMainnet.USDC, "USDC");
        vm.label(ArcMainnet.EURC, "EURC");
        vm.label(ArcMainnet.CIRBTC, "cirBTC");
        vm.label(ArcMainnet.BTC_USD_FEED, "BTC/USD feed");
        vm.label(ArcMainnet.EUR_USD_FEED, "EUR/USD feed");
        vm.label(PAYER, "Payer (demo wallet)");
    }

    function makeBill(address payee, address currency, uint256 amount, bytes memory ref)
        internal
        returns (uint256 id)
    {
        vm.prank(payee);
        id = adag.createBill(currency, amount, 0, ref);
    }

    /// @dev Pays from the payer's balance: exact approval, then pay through Memo.
    function payCash(address payer, uint256 id) internal {
        runBatch(payer, cashCalls(id));
    }

    /// @dev Pledges, borrows to the payer's own wallet, approves the exact bill amount, then pays through Memo.
    function payWithLoan(address payer, uint256 id, uint256 collateral, uint256 borrow) internal {
        runBatch(payer, loanCalls(payer, id, collateral, borrow));
    }

    /// @dev Built apart from the send, so a test can set expectEmit or expectRevert on the batch call alone.
    function cashCalls(uint256 id) internal view returns (IMulticall3From.Call3[] memory calls) {
        AdagBills.Bill memory b = adag.bill(id);
        calls = new IMulticall3From.Call3[](2);
        calls[0] = call3(b.currency, abi.encodeCall(IERC20.approve, (address(adag), b.amount)));
        calls[1] = memoPayCall(id, b.ref);
    }

    function loanCalls(address payer, uint256 id, uint256 collateral, uint256 borrow)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        AdagBills.Bill memory b = adag.bill(id);
        MarketParams memory params = marketParams(b.currency);
        calls = new IMulticall3From.Call3[](5);
        calls[0] = call3(ArcMainnet.CIRBTC, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, collateral)));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.supplyCollateral, (params, collateral, payer, "")));
        calls[2] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.borrow, (params, borrow, 0, payer, payer)));
        calls[3] = call3(b.currency, abi.encodeCall(IERC20.approve, (address(adag), b.amount)));
        calls[4] = memoPayCall(id, b.ref);
    }

    function memoPayCall(uint256 id, bytes memory ref) internal view returns (IMulticall3From.Call3 memory) {
        return call3(ArcMainnet.MEMO, abi.encodeCall(IMemo.memo, (address(adag), payData(id), bytes32(id), ref)));
    }

    function payData(uint256 id) internal pure returns (bytes memory) {
        return abi.encodeCall(AdagBills.pay, (id));
    }

    function call3(address target, bytes memory data) internal pure returns (IMulticall3From.Call3 memory) {
        return IMulticall3From.Call3(target, false, data);
    }

    /// @dev The payer is both msg.sender and tx.origin, which Arc's CallFrom requires.
    function runBatch(address payer, IMulticall3From.Call3[] memory calls) internal {
        vm.startPrank(payer, payer);
        IMulticall3From(ArcMainnet.MULTICALL3_FROM).aggregate3(calls);
        vm.stopPrank();
    }

    function marketParams(address currency) internal view returns (MarketParams memory p) {
        bytes32 id = currency == ArcMainnet.USDC ? ArcMainnet.MARKET_USDC : ArcMainnet.MARKET_EURC;
        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = MORPHO.idToMarketParams(id);
    }

    function paramsOf(bytes32 marketId) internal view returns (MarketParams memory p) {
        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = MORPHO.idToMarketParams(marketId);
    }

    /// @dev Approve cirBTC, pledge it and borrow to the payer's own wallet: the three plain Morpho steps.
    function pledgeAndBorrowCalls(address payer, bytes32 marketId, uint256 collateral, uint256 borrow)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        MarketParams memory params = paramsOf(marketId);
        calls = new IMulticall3From.Call3[](3);
        calls[0] = call3(ArcMainnet.CIRBTC, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, collateral)));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.supplyCollateral, (params, collateral, payer, "")));
        calls[2] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.borrow, (params, borrow, 0, payer, payer)));
    }

    /// @dev Borrows through Morpho alone, with no Adag step, the way a payer could outside the app.
    function borrowDirect(address payer, bytes32 marketId, uint256 collateral, uint256 borrow) internal {
        runBatch(payer, pledgeAndBorrowCalls(payer, marketId, collateral, borrow));
    }

    /// @dev Repays an exact share count, then resets the loan token approval to zero.
    function repayShares(address payer, bytes32 marketId, uint256 shares) internal {
        MarketParams memory params = paramsOf(marketId);
        IMulticall3From.Call3[] memory calls = new IMulticall3From.Call3[](3);
        calls[0] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, withMargin(assetsOf(marketId, shares)))));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.repay, (params, 0, shares, payer, "")));
        calls[2] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, 0)));
        runBatch(payer, calls);
    }

    /// @dev The close the app will offer: repay by the live share count, take all collateral back and leave no
    /// standing approval, in one batch.
    function closeLoan(address payer, bytes32 marketId) internal {
        runBatch(payer, closeLoanCalls(payer, marketId));
    }

    function closeLoanCalls(address payer, bytes32 marketId)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        MarketParams memory params = paramsOf(marketId);
        (, uint128 shares, uint128 collateral) = MORPHO.position(marketId, payer);
        calls = new IMulticall3From.Call3[](4);
        calls[0] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, withMargin(assetsOf(marketId, shares)))));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.repay, (params, 0, uint256(shares), payer, "")));
        calls[2] = call3(
            ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.withdrawCollateral, (params, uint256(collateral), payer, payer))
        );
        calls[3] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, 0)));
    }

    /// @dev Debt for a share count from the stored market totals, rounded up the way Morpho's repay charges it.
    /// Totals exclude interest since the last update, so callers add withMargin.
    function assetsOf(bytes32 marketId, uint256 shares) internal view returns (uint256) {
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        return Math.mulDiv(shares, uint256(totalAssets) + 1, uint256(totalShares) + 1e6, Math.Rounding.Ceil);
    }

    /// @dev Debt plus 0.1% and one unit: covers the interest a repay accrues first.
    function withMargin(uint256 debt) internal pure returns (uint256) {
        return debt + debt / 1000 + 1;
    }

    /// @dev The borrow that puts `collateral` at `ltvWad` from the live oracle price, rounded down.
    function borrowForLtv(bytes32 marketId, uint256 collateral, uint256 ltvWad) internal view returns (uint256) {
        uint256 price = IOracleMinimal(paramsOf(marketId).oracle).price();
        return Math.mulDiv(Math.mulDiv(collateral, price, 1e36), ltvWad, 1e18);
    }

    /// @dev Replaces the market oracle's price for every caller, Morpho included.
    function mockPrice(bytes32 marketId, uint256 newPrice) internal {
        vm.mockCall(paramsOf(marketId).oracle, abi.encodeWithSelector(IOracleMinimal.price.selector), abi.encode(newPrice));
    }

    /// @dev Keeps a Chainlink feed's live answer but stamps it with the current block time.
    function mockFreshFeed(address feed) internal {
        (uint80 roundId, int256 answer,,, uint80 answeredInRound) = IChainlinkFeed(feed).latestRoundData();
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IChainlinkFeed.latestRoundData.selector),
            abi.encode(roundId, answer, block.timestamp, block.timestamp, answeredInRound)
        );
    }

    /// @dev Like runBatch, but returns the revert instead of bubbling it, so a test can read Adag's error.
    function tryBatch(address payer, IMulticall3From.Call3[] memory calls)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.startPrank(payer, payer);
        (ok, ret) = ArcMainnet.MULTICALL3_FROM.call(abi.encodeCall(IMulticall3From.aggregate3, (calls)));
        vm.stopPrank();
    }

    /// @dev Adag's own revert data from inside a failed Memo step. Multicall3From passes MemoFailed up unchanged.
    function adagError(bytes memory ret) internal view returns (bytes memory) {
        assertEq(bytes4(ret), IMemo.MemoFailed.selector, "batch did not fail inside Memo");
        return abi.decode(this.dropSelector(ret), (bytes));
    }

    /// @dev External so it can slice calldata; memory bytes cannot be sliced.
    function dropSelector(bytes calldata data) external pure returns (bytes memory) {
        return data[4:];
    }

    function concat(IMulticall3From.Call3[] memory a, IMulticall3From.Call3[] memory b)
        internal
        pure
        returns (IMulticall3From.Call3[] memory out)
    {
        out = new IMulticall3From.Call3[](a.length + b.length);
        for (uint256 i; i < a.length; ++i) {
            out[i] = a[i];
        }
        for (uint256 i; i < b.length; ++i) {
            out[a.length + i] = b[i];
        }
    }

    /// @dev Approve and pledge only, no borrow.
    function pledgeCalls(address payer, bytes32 marketId, uint256 collateral)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        MarketParams memory params = paramsOf(marketId);
        calls = new IMulticall3From.Call3[](2);
        calls[0] = call3(ArcMainnet.CIRBTC, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, collateral)));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.supplyCollateral, (params, collateral, payer, "")));
    }

    /// @dev Borrow only, against collateral already pledged.
    function borrowCalls(address payer, bytes32 marketId, uint256 borrow)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        calls = new IMulticall3From.Call3[](1);
        calls[0] = call3(
            ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.borrow, (paramsOf(marketId), borrow, 0, payer, payer))
        );
    }

    /// @dev The borrow shares Adag has recorded for the demo wallet in a market.
    function recordedShares(bytes32 marketId) internal view returns (uint256 shares) {
        (shares,) = adag.seenPosition(PAYER, marketId);
    }

    /// @dev The pledged cirBTC Adag has recorded for the demo wallet in a market.
    function recordedCollateral(bytes32 marketId) internal view returns (uint256 collateral) {
        (, collateral) = adag.seenPosition(PAYER, marketId);
    }

    /// @dev Borrow an exact share count, the input a payer controls when reproducing a position Adag recorded.
    function borrowSharesCalls(address payer, bytes32 marketId, uint256 shares)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        calls = new IMulticall3From.Call3[](1);
        calls[0] = call3(
            ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.borrow, (paramsOf(marketId), 0, shares, payer, payer))
        );
    }

    /// @dev Take pledged cirBTC back to the payer's wallet, outside Adag.
    function withdrawCollateralCalls(address payer, bytes32 marketId, uint256 amount)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        calls = new IMulticall3From.Call3[](1);
        calls[0] = call3(
            ArcMainnet.MORPHO,
            abi.encodeCall(IMorphoBorrow.withdrawCollateral, (paramsOf(marketId), amount, payer, payer))
        );
    }

    /// @dev The batch repayShares sends, built apart so a caller can try it without reverting.
    function repaySharesCalls(address payer, bytes32 marketId, uint256 shares)
        internal
        view
        returns (IMulticall3From.Call3[] memory calls)
    {
        MarketParams memory params = paramsOf(marketId);
        calls = new IMulticall3From.Call3[](3);
        calls[0] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, withMargin(assetsOf(marketId, shares)))));
        calls[1] = call3(ArcMainnet.MORPHO, abi.encodeCall(IMorphoBorrow.repay, (params, 0, shares, payer, "")));
        calls[2] = call3(params.loanToken, abi.encodeCall(IERC20.approve, (ArcMainnet.MORPHO, 0)));
    }

    // The three helpers below restate Morpho's formulas in plain integer maths, written apart from AdagBills, so
    // tests can judge Adag's answers against something that does not share its code.

    /// @dev A user's debt from the stored market totals, rounded up (Morpho's toAssetsUp).
    function independentDebt(bytes32 marketId, address user) internal view returns (uint256) {
        (, uint128 shares,) = MORPHO.position(marketId, user);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        uint256 denominator = uint256(totalShares) + 1e6;
        return (uint256(shares) * (uint256(totalAssets) + 1) + denominator - 1) / denominator;
    }

    /// @dev 40% of a user's collateral value at the oracle's current price, both steps rounded down.
    function independentLine(bytes32 marketId, address user) internal view returns (uint256) {
        (,, uint128 collateral) = MORPHO.position(marketId, user);
        return independentLineFor(marketId, collateral);
    }

    function independentLineFor(bytes32 marketId, uint256 collateral) internal view returns (uint256) {
        uint256 price = IOracleMinimal(paramsOf(marketId).oracle).price();
        return collateral * price / 1e36 * 4 / 10;
    }

    /// @dev The user's debt right after Morpho lends `assets` more, in a block where interest is already accrued:
    /// Morpho mints shares rounding up, then the whole position converts back rounding up on the new totals.
    function independentDebtAfterBorrow(bytes32 marketId, address user, uint256 assets)
        internal
        view
        returns (uint256 debt, uint256 newShares)
    {
        (, uint128 shares,) = MORPHO.position(marketId, user);
        (,, uint128 totalAssets, uint128 totalShares,,) = MORPHO.market(marketId);
        uint256 a = uint256(totalAssets) + 1;
        uint256 s = uint256(totalShares) + 1e6;
        newShares = (assets * s + a - 1) / a;
        uint256 denominator = s + newShares;
        debt = ((uint256(shares) + newShares) * (a + assets) + denominator - 1) / denominator;
    }

    function assertAdagHoldsNothing() internal view {
        assertEq(USDC.balanceOf(address(adag)), 0, "Adag holds USDC");
        assertEq(EURC.balanceOf(address(adag)), 0, "Adag holds EURC");
        assertEq(CIRBTC.balanceOf(address(adag)), 0, "Adag holds cirBTC");
    }
}
