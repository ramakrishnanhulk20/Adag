import { parseAbi } from "viem";

// Slices of packages/contracts/deployments/AdagBills.abi.json and the Morpho oracle interface that abi.ts does not carry.
export const adagPledgeAbi = parseAbi([
  "function collateralNeeded(address user, bytes32 marketId, uint256 extraBorrow) view returns (uint256 extraCollateral)",
]);

export const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
