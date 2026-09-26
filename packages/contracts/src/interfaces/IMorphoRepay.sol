// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MarketParams} from "./IMorphoMinimal.sol";

interface IMorphoRepay {
    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);
}
