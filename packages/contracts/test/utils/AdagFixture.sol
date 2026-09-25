// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdagBills} from "../../src/AdagBills.sol";
import {MarketParams} from "../../src/interfaces/IMorphoMinimal.sol";
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

    function assertAdagHoldsNothing() internal view {
        assertEq(USDC.balanceOf(address(adag)), 0, "Adag holds USDC");
        assertEq(EURC.balanceOf(address(adag)), 0, "Adag holds EURC");
        assertEq(CIRBTC.balanceOf(address(adag)), 0, "Adag holds cirBTC");
    }
}
