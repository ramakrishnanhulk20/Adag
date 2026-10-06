import { parseAbi } from "viem";

const mp = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";

// The first deployment's entries (deployments/2026-09-25/AdagBills.abi.json) for everything the app reads, writes or
// decodes. The current deployment has every one of them unchanged, so reads and pay calls use one ABI for both.
const FIRST_ENTRIES = [
  "function createBill(address currency, uint256 amount, uint64 due, bytes ref) returns (uint256 id)",
  "function voidBill(uint256 id)",
  "function pay(uint256 id)",
  "function bill(uint256 id) view returns ((address payee, uint8 status, uint64 due, address currency, uint64 createdAt, uint256 amount, address payer, uint64 paidAt, bytes ref))",
  "function billCount() view returns (uint256)",
  "function billsOfPayee(address payee, uint256 offset, uint256 limit) view returns (uint256[] ids, uint256 total)",
  "function paymentsOfPayer(address payer, uint256 offset, uint256 limit) view returns (uint256[] ids, uint256 total)",
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
] as const;

export const adagFirstAbi = parseAbi(FIRST_ENTRIES);

// The current deployment (deployments/2026-09-26/AdagBills.abi.json) adds enrol. Only the current contract is ever
// called with these.
export const adagAbi = parseAbi([
  ...FIRST_ENTRIES,
  "function enrol()",
  "function enrolledAt(address payer) view returns (uint64 blockNumber)",
  "event Enrolled(address indexed payer, uint256 usdcShares, uint256 usdcCollateral, uint256 eurcShares, uint256 eurcCollateral)",
  "error EnrolledThisBlock()",
]);

export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${mp}`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  `function supplyCollateral(${mp} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdrawCollateral(${mp} marketParams, uint256 assets, address onBehalf, address receiver)`,
  "function isAuthorized(address authorizer, address authorized) view returns (bool)",
  "function setAuthorization(address authorized, bool newIsAuthorized)",
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)",
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  // OpenZeppelin 5 token errors, in case a token on Arc reverts with them instead of a string.
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidSender(address sender)",
]);

export const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

// The two reads AdagBills itself makes to get the euro price (AdagBills._feeds and _readFeed): the market oracle's
// QUOTE_FEED_1, then that Chainlink feed's latestRoundData. decimals is read once so the answer can be scaled.
export const oracleFeedsAbi = parseAbi(["function QUOTE_FEED_1() view returns (address)"]);
export const chainlinkFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

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

// Circle's swap adapter, exactly as scripts/check-fx.mjs encodes it. Only execute is ever called. The plan's
// parameters and signature come from Circle's API; the one token input is written by this app (C66).
export const circleAdapterAbi = parseAbi([
  "function execute(((address target, bytes data, uint256 value, address tokenIn, uint256 amountToApprove, address tokenOut, uint256 minTokenOut)[] instructions, (address token, address beneficiary)[] tokens, uint256 execId, uint256 deadline, bytes metadata) params, (uint8 permitType, address token, uint256 amount, bytes permitCalldata)[] tokenInputs, bytes signature) payable",
]);
