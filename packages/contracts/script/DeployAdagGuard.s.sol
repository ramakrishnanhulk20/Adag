// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AdagGuard} from "../src/AdagGuard.sol";

// Deploys AdagGuard to Arc mainnet. Run it through deploy-guard.sh, never by hand.
// Dry run (the default) broadcasts as DEPLOYER_ADDRESS_PUBLIC, so forge only simulates and no key is read.
// Broadcast reads DEPLOYER_PRIVATE_KEY and stops unless that key belongs to DEPLOYER_ADDRESS_PUBLIC.
contract DeployAdagGuard is Script {
    uint256 private constant ARC_MAINNET = 5042;
    address private constant EXPECTED_MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    bytes32 private constant EXPECTED_MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    bytes32 private constant EXPECTED_MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;

    error WrongChain(uint256 chainId);
    error KeyNotForDeployer(address fromKey, address expected);
    error NoCodeDeployed(address at);
    error WrongBytecode(string constantName);

    function run() external returns (AdagGuard guard) {
        if (block.chainid != ARC_MAINNET) revert WrongChain(block.chainid);
        address deployer = vm.envAddress("DEPLOYER_ADDRESS_PUBLIC");

        if (vm.envOr("ADAG_BROADCAST", false)) {
            uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
            address fromKey = vm.addr(key);
            if (fromKey != deployer) revert KeyNotForDeployer(fromKey, deployer);
            vm.startBroadcast(key);
        } else {
            vm.startBroadcast(deployer);
        }
        guard = new AdagGuard();
        vm.stopBroadcast();

        console.log("AdagGuard deployed at", address(guard));

        if (address(guard).code.length == 0) revert NoCodeDeployed(address(guard));
        if (guard.MORPHO() != EXPECTED_MORPHO) revert WrongBytecode("MORPHO");
        if (guard.MARKET_USDC() != EXPECTED_MARKET_USDC) revert WrongBytecode("MARKET_USDC");
        if (guard.MARKET_EURC() != EXPECTED_MARKET_EURC) revert WrongBytecode("MARKET_EURC");
        if (guard.holderCount() != 0) revert WrongBytecode("holderCount");
        // Reverts BadMarket unless both live Morpho markets still pass the guard's own checks.
        guard.quote(address(0), EXPECTED_MARKET_USDC);
        guard.quote(address(0), EXPECTED_MARKET_EURC);
    }
}
