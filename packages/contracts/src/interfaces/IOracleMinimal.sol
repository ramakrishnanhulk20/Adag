// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The parts of Morpho's MorphoChainlinkOracleV2 that Adag reads. The feed getters return
/// AggregatorV3Interface in the source, which is an address in the ABI.
interface IOracleMinimal {
    /// @dev Price of 1 base unit of collateral in base units of the loan token, scaled by 1e36.
    function price() external view returns (uint256);

    function BASE_FEED_1() external view returns (address);

    function QUOTE_FEED_1() external view returns (address);
}
