import { parseAbi } from "viem";

const mp = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";

// Matches packages/contracts/deployments/AdagBills.abi.json for every entry the app reads, writes or decodes.
export const adagAbi = parseAbi([
  "function createBill(address currency, uint256 amount, uint64 due, bytes ref) returns (uint256 id)",
  "function voidBill(uint256 id)",
  "function pay(uint256 id)",
  "function bill(uint256 id) view returns ((address payee, uint8 status, uint64 due, address currency, uint64 createdAt, uint256 amount, address payer, uint64 paidAt, bytes ref))",
  "function billCount() view returns (uint256)",
  "function loanToValue(address user, bytes32 marketId) view returns (uint256)",
  "function collateralNeeded(address user, bytes32 marketId, uint256 extraBorrow) view returns (uint256)",
  "function priceStatus(bytes32 marketId) view returns (bool fresh, uint256 btcUsdUpdatedAt, uint256 eurUsdUpdatedAt)",
  "function seenPosition(address payer, bytes32 marketId) view returns (uint256 shares, uint256 collateral)",
  "event BillCreated(uint256 indexed id, address indexed payee, address indexed currency, uint256 amount, uint64 due, bytes ref)",
  "event BillVoided(uint256 indexed id, address indexed payee)",
  "event BillPaid(uint256 indexed id, address indexed payer, address indexed payee, address currency, uint256 amount, bool loanChecked)",
  "event DebtRecorded(address indexed payer, bytes32 indexed marketId, uint256 borrowShares, uint256 collateral, bool checked)",
  "error BadFeed(address oracle)",
  "error BadMarket(bytes32 marketId)",
  "error BillNotOpen(uint256 id, uint8 status)",
  "error LtvAboveLimit(bytes32 marketId, uint256 borrowed, uint256 maxBorrow)",
  "error NotPayee(address caller)",
  "error PageTooLarge(uint256 limit)",
  "error PayeeNotCredited(uint256 rise, uint256 amount)",
  "error ReentrancyGuardReentrantCall()",
  "error ReferenceTooLong(uint256 length)",
  "error SafeERC20FailedOperation(address token)",
  "error SelfPayment()",
  "error StalePrice(address feed, uint256 updatedAt)",
  "error UnknownBill(uint256 id)",
  "error UnsupportedCurrency(address currency)",
  "error ZeroAmount()",
  "error ZeroPrice()",
]);

export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${mp}`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  `function supplyCollateral(${mp} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  // OpenZeppelin 5 token errors, in case a token on Arc reverts with them instead of a string.
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidSender(address sender)",
]);

export const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

const marketState =
  "(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)";
export const irmAbi = parseAbi([`function borrowRateView(${mp} marketParams, ${marketState} market) view returns (uint256)`]);

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
  "error MemoFailed(bytes returnData)",
]);

export const multicall3FromAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) returns (Result[] returnData)",
]);
