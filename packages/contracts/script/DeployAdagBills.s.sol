// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AdagBills} from "../src/AdagBills.sol";

/// @notice Deploys AdagBills to Arc mainnet. Run it through deploy.sh, never by hand.
/// @dev Two modes, picked by ADAG_BROADCAST. Dry run (the default) broadcasts as DEPLOYER_ADDRESS_PUBLIC so forge
/// only simulates and no key is ever read. Broadcast reads DEPLOYER_PRIVATE_KEY and refuses to go on unless that key
/// belongs to DEPLOYER_ADDRESS_PUBLIC, the address deploy.sh checked the balance of.
contract DeployAdagBills is Script {
    uint256 private constant ARC_MAINNET = 5042;
    uint256 private constant EXPECTED_MAX_LTV_WAD = 0.4e18;
    bytes32 private constant EXPECTED_MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    bytes32 private constant EXPECTED_MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;

    error WrongChain(uint256 chainId);
    error KeyNotForDeployer(address fromKey, address expected);
    error NoCodeDeployed(address at);
    error WrongBytecode(string constantName);

    /// @notice Deploys AdagBills and checks the new contract carries the expected constants.
    /// @dev Reverts WrongChain off Arc mainnet, KeyNotForDeployer if the key and the public address disagree,
    /// NoCodeDeployed or WrongBytecode if what landed is not AdagBills as this repo builds it.
    /// @return bills The deployed contract.
    function run() external returns (AdagBills bills) {
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
        bills = new AdagBills();
        vm.stopBroadcast();

        console.log("AdagBills deployed at", address(bills));

        if (address(bills).code.length == 0) revert NoCodeDeployed(address(bills));
        if (bills.MAX_LTV_WAD() != EXPECTED_MAX_LTV_WAD) revert WrongBytecode("MAX_LTV_WAD");
        if (bills.MARKET_USDC() != EXPECTED_MARKET_USDC) revert WrongBytecode("MARKET_USDC");
        if (bills.MARKET_EURC() != EXPECTED_MARKET_EURC) revert WrongBytecode("MARKET_EURC");
        // The first deployment has no enrolledAt, so this call reverts if that older build was deployed by mistake.
        if (bills.enrolledAt(deployer) != 0) revert WrongBytecode("enrolledAt");
    }
}
