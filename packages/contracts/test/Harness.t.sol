// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Proves this harness drives Arc's Memo and Multicall3From as a real wallet on a mainnet fork, and reads both Adag markets.
// Not covered: Morpho supply, borrow, repay or health, oracle prices, EURC or cirBTC transfers, EIP-7702 wallets,
// and anything signed or broadcast. Results follow live mainnet state, so DEMO_WALLET must still hold 0.01 USDC.

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcMainnet} from "./utils/ArcMainnet.sol";
import {Id, MarketParams, IMorpho, IMemo, IMulticall3From} from "./utils/ArcInterfaces.sol";

/// @dev Stands in for a smart-contract wallet: a contract, not the transaction's origin, calling Memo.
contract MemoCaller {
    function tagBalanceRead(address memo, address token) external {
        IMemo(memo).memo(token, abi.encodeCall(IERC20.balanceOf, (address(this))), bytes32(uint256(1)), "");
    }
}

contract HarnessTest is Test {
    address internal constant PAYEE = address(0xA11CE);
    // 0.01 USDC through the 6-decimal token interface, never the 18-decimal native view.
    uint256 internal constant AMOUNT = 10_000;
    bytes32 internal constant MEMO_ID = bytes32(uint256(42));
    bytes internal constant MEMO_DATA = "INV-42";

    IERC20 internal constant USDC = IERC20(ArcMainnet.USDC);

    function setUp() public view {
        assertEq(block.chainid, ArcMainnet.CHAIN_ID, "not an Arc mainnet fork");
        assertGe(USDC.balanceOf(ArcMainnet.DEMO_WALLET), AMOUNT, "demo wallet cannot cover the test transfer");
    }

    function test_marketsResolve() public view {
        _assertMarket(ArcMainnet.MARKET_USDC, ArcMainnet.USDC);
        _assertMarket(ArcMainnet.MARKET_EURC, ArcMainnet.EURC);
    }

    function test_multicall3FromActsAsWallet() public {
        IMulticall3From.Call3[] memory calls = new IMulticall3From.Call3[](1);
        calls[0] = IMulticall3From.Call3(ArcMainnet.USDC, false, _transferData());
        (uint256 walletBefore, uint256 payeeBefore) = _balances();

        vm.startPrank(ArcMainnet.DEMO_WALLET, ArcMainnet.DEMO_WALLET);
        IMulticall3From.Result[] memory results = IMulticall3From(ArcMainnet.MULTICALL3_FROM).aggregate3(calls);
        vm.stopPrank();

        assertTrue(results[0].success, "batched transfer failed");
        assertTrue(abi.decode(results[0].returnData, (bool)), "transfer returned false");
        _assertMoved(walletBefore, payeeBefore);
    }

    function test_memoTagsTransfer() public {
        bytes memory data = _transferData();
        (uint256 walletBefore, uint256 payeeBefore) = _balances();

        vm.recordLogs();
        vm.startPrank(ArcMainnet.DEMO_WALLET, ArcMainnet.DEMO_WALLET);
        // memoIndex is a global counter with no getter, so the data half is checked from the recorded log below.
        vm.expectEmit(true, true, true, false, ArcMainnet.MEMO);
        emit IMemo.Memo(ArcMainnet.DEMO_WALLET, ArcMainnet.USDC, keccak256(data), MEMO_ID, MEMO_DATA, 0);
        IMemo(ArcMainnet.MEMO).memo(ArcMainnet.USDC, data, MEMO_ID, MEMO_DATA);
        vm.stopPrank();

        (bytes32 callDataHash, bytes memory memoData) = _memoLogData(vm.getRecordedLogs());
        assertEq(callDataHash, keccak256(data), "memo hashed a different call");
        assertEq(memoData, MEMO_DATA, "memo bytes changed");
        _assertMoved(walletBefore, payeeBefore);
    }

    function test_nestedMulticallMemo() public {
        bytes memory data = _transferData();
        IMulticall3From.Call3[] memory calls = new IMulticall3From.Call3[](1);
        calls[0] = IMulticall3From.Call3(
            ArcMainnet.MEMO, false, abi.encodeCall(IMemo.memo, (ArcMainnet.USDC, data, MEMO_ID, MEMO_DATA))
        );
        (uint256 walletBefore, uint256 payeeBefore) = _balances();

        vm.startPrank(ArcMainnet.DEMO_WALLET, ArcMainnet.DEMO_WALLET);
        vm.expectEmit(true, true, true, false, ArcMainnet.MEMO);
        emit IMemo.Memo(ArcMainnet.DEMO_WALLET, ArcMainnet.USDC, keccak256(data), MEMO_ID, MEMO_DATA, 0);
        IMulticall3From.Result[] memory results = IMulticall3From(ArcMainnet.MULTICALL3_FROM).aggregate3(calls);
        vm.stopPrank();

        assertTrue(results[0].success, "memo step failed inside the batch");
        _assertMoved(walletBefore, payeeBefore);
    }

    function test_contractCallerRejected() public {
        MemoCaller caller = new MemoCaller();
        bytes memory balanceRead = abi.encodeCall(IERC20.balanceOf, (ArcMainnet.DEMO_WALLET));

        vm.startPrank(ArcMainnet.DEMO_WALLET, ArcMainnet.DEMO_WALLET);
        // Control: the same kind of call made by the wallet itself goes through, so only the caller differs below.
        IMemo(ArcMainnet.MEMO).memo(ArcMainnet.USDC, balanceRead, bytes32(uint256(1)), "");
        vm.expectRevert(bytes("sender spoofing requires tx.origin as sender"));
        caller.tagBalanceRead(ArcMainnet.MEMO, ArcMainnet.USDC);
        vm.stopPrank();
    }

    function _assertMarket(bytes32 id, address expectedLoanToken) internal view {
        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            IMorpho(ArcMainnet.MORPHO).idToMarketParams(Id.wrap(id));
        assertEq(loanToken, expectedLoanToken, "loan token");
        assertEq(collateralToken, ArcMainnet.CIRBTC, "collateral token");
        assertEq(lltv, ArcMainnet.MARKET_LLTV, "lltv");
        // Morpho derives the id from the five params, so a match means these are the params Morpho will use.
        assertEq(
            keccak256(abi.encode(MarketParams(loanToken, collateralToken, oracle, irm, lltv))),
            id,
            "params do not hash to the market id"
        );
    }

    function _transferData() internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (PAYEE, AMOUNT));
    }

    function _balances() internal view returns (uint256 wallet, uint256 payee) {
        return (USDC.balanceOf(ArcMainnet.DEMO_WALLET), USDC.balanceOf(PAYEE));
    }

    function _assertMoved(uint256 walletBefore, uint256 payeeBefore) internal view {
        (uint256 walletAfter, uint256 payeeAfter) = _balances();
        assertEq(walletBefore - walletAfter, AMOUNT, "wallet was not the sender");
        assertEq(payeeAfter - payeeBefore, AMOUNT, "payee did not receive");
    }

    function _memoLogData(Vm.Log[] memory logs) internal pure returns (bytes32 callDataHash, bytes memory memoData) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ArcMainnet.MEMO && logs[i].topics[0] == IMemo.Memo.selector) {
                (callDataHash, memoData,) = abi.decode(logs[i].data, (bytes32, bytes, uint256));
                return (callDataHash, memoData);
            }
        }
        revert("no Memo event");
    }
}
