// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { parseAbi } from "viem";

// AdagGuard's interface, as packages/contracts/src/AdagGuard.sol declares it.
export const guardAbi = parseAbi([
  "struct Rule { uint64 triggerWad; uint64 targetWad; uint64 expiry; }",
  "function setRule(bytes32 marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry)",
  "function clearRule(bytes32 marketId)",
  "function protect(address borrower, bytes32 marketId) returns (uint256 repaid)",
  "function ruleOf(address borrower, bytes32 marketId) view returns (Rule)",
  "function quote(address borrower, bytes32 marketId) view returns (bool wouldAct, uint256 amount, uint256 ltvWad)",
  "function holderCount() view returns (uint256)",
  "function holders(uint256 offset, uint256 limit) view returns (address[])",
  "event RuleSet(address indexed borrower, bytes32 indexed marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry)",
  "event RuleCleared(address indexed borrower, bytes32 indexed marketId)",
  "event Protected(address indexed borrower, bytes32 indexed marketId, uint256 repaid, uint256 ltvBeforeWad, uint256 ltvAfterWad)",
]);

// The keeper's only write. Kept apart so the calldata builder cannot reach any other function (C39).
export const protectAbi = parseAbi(["function protect(address borrower, bytes32 marketId) returns (uint256 repaid)"]);

// Chainlink's proxy names the aggregator behind it; the aggregator is what emits AnswerUpdated.
export const feedProxyAbi = parseAbi(["function aggregator() view returns (address)"]);
export const answerUpdatedEvent = parseAbi(["event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)"]);
