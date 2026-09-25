// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Same layout as morpho-blue MarketParams (IMorpho.sol). Morpho hashes these five words into the market id.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice The parts of Morpho Blue v1 that Adag reads or calls. Morpho's `Id` type is a bytes32 in the ABI.
interface IMorphoMinimal {
    function idToMarketParams(bytes32 id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);

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

    function accrueInterest(MarketParams memory marketParams) external;
}
