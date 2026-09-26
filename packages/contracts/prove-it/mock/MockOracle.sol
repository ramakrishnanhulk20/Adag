// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Simulation only. Injected with eth_simulateV1 state overrides at a real Morpho oracle's address to fake a
// bitcoin price move. lib.mjs patches the three sentinel constants below in the runtime bytecode: the price,
// and the real oracle's two feed addresses, so Adag's freshness check still reads the real Chainlink feeds.
contract MockOracle {
    uint256 internal constant PRICE = 0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed;
    address internal constant BASE_FEED = 0xB0B0b0B0B0B0B0b0B0B0B0b0b0b0b0B0b0b0B0B0;
    address internal constant QUOTE_FEED = 0xC0C0c0c0C0C0c0c0c0C0c0C0C0C0C0C0C0C0c0c0;

    function price() external pure returns (uint256) {
        return PRICE;
    }

    function BASE_FEED_1() external pure returns (address) {
        return BASE_FEED;
    }

    function QUOTE_FEED_1() external pure returns (address) {
        return QUOTE_FEED;
    }
}
