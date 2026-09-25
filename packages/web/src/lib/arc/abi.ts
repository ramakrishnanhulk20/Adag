import { parseAbi } from "viem";

const marketParams = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const market =
  "(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)";

// The read-only slice of packages/contracts/deployments/AdagBills.abi.json that the landing page uses.
export const adagAbi = parseAbi([
  "function billCount() view returns (uint256)",
  "function bill(uint256 id) view returns ((address payee, uint8 status, uint64 due, address currency, uint64 createdAt, uint256 amount, address payer, uint64 paidAt, bytes ref))",
  "function MAX_LTV_WAD() view returns (uint256)",
  "function priceStatus(bytes32 marketId) view returns (bool fresh, uint256 btcUsdUpdatedAt, uint256 eurUsdUpdatedAt)",
  "event BillPaid(uint256 indexed id, address indexed payer, address indexed payee, address currency, uint256 amount, bool loanChecked)",
]);

export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${marketParams}`,
  `function market(bytes32 id) view returns ${market}`,
]);

export const irmAbi = parseAbi([`function borrowRateView(${marketParams} marketParams, ${market} market) view returns (uint256)`]);

export const BILL_STATUS_PAID = 2;
