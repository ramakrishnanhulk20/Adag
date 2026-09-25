// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IOracleMinimal {
    function price() external view returns (uint256);

    function BASE_FEED_1() external view returns (address);

    function QUOTE_FEED_1() external view returns (address);
}
