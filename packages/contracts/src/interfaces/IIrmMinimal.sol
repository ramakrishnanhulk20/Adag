// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MarketParams} from "./IMorphoMinimal.sol";

// Morpho Blue's Market struct, field for field, so the call below encodes the same bytes Morpho sends.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

interface IIrmMinimal {
    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256);
}
