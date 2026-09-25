// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Arc mainnet (chain 5042) addresses and ids the fork tests read. Probed on 25 September 2026.
library ArcMainnet {
    uint256 internal constant CHAIN_ID = 5042;

    address internal constant MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    address internal constant MEMO = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    address internal constant MULTICALL3_FROM = 0x522fAf9A91c41c443c66765030741e4AaCe147D0;

    /// @dev The 6-decimal ERC-20 view of native USDC. The same balance reads as 18 decimals natively.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address internal constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;

    /// @dev Loan USDC against cirBTC, lltv 86%.
    bytes32 internal constant MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    /// @dev Loan EURC against cirBTC, lltv 86%.
    bytes32 internal constant MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;
    uint256 internal constant MARKET_LLTV = 0.86e18;

    /// @dev Chainlink BTC / USD, 8 decimals. Base feed of both market oracles.
    address internal constant BTC_USD_FEED = 0x7777547914e03BCbB04Ae034942765a0dbb26aE3;
    /// @dev Chainlink EUR / USD, 8 decimals. Quote feed of the EURC market oracle.
    address internal constant EUR_USD_FEED = 0xa4266689D107aF71c7dBE975cfB92aB40E7b4EFE;

    /// @dev WETH on Arc. A real token that is not the loan token of either Adag market.
    address internal constant WETH = 0x128cC466B61f542da60c70e3aA11c10e19B84EDB;

    /// @dev Our demo wallet: 5 USDC and 0.00011973 cirBTC on mainnet at the time of writing.
    address internal constant DEMO_WALLET = 0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE;
}
