// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { EURC, MARKET_EURC, MARKET_USDC, MORPHO, USDC } from "../arc/constants";
import { feedProxyAbi, guardAbi } from "./abi";
import { FEEDS, GUARD_MARKETS, HOLDER_PAGE, MULTICALL3, PAGES_PER_RUN } from "./constants";

// Only these reads, so a test can stand in for the chain with a small fake.
export type KeeperClient = Pick<PublicClient, "getBlock" | "readContract" | "multicall" | "call" | "estimateGas" | "waitForTransactionReceipt">;

export type Loan = { borrower: Address; market: Hex };
export type Quote = Loan & { wouldAct: boolean; amount: bigint; ltvWad: bigint };
export type Rule = { triggerWad: bigint; targetWad: bigint; expiry: bigint };

const positionAbi = parseAbi(["function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"]);
const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const LOAN_TOKEN: Record<string, Address> = { [MARKET_USDC]: USDC, [MARKET_EURC]: EURC };

// This run's slice of AdagGuard's on-chain holder set (C43): PAGES_PER_RUN pages from the cursor, and where the next
// run starts. Past the end it wraps to the start, so every holder comes round within ceil(total / slice) runs.
export async function readHolderPage(client: KeeperClient, guard: Address, cursor: bigint, blockNumber: bigint): Promise<{ holders: Address[]; total: bigint; start: bigint; next: bigint }> {
  const total = await client.readContract({ address: guard, abi: guardAbi, functionName: "holderCount", blockNumber });
  const start = cursor < total ? cursor : 0n;
  const offsets: bigint[] = [];
  for (let i = 0; i < PAGES_PER_RUN; i++) {
    const offset = start + BigInt(i * HOLDER_PAGE);
    if (offset < total) offsets.push(offset);
  }
  const pages = await Promise.all(
    offsets.map((offset) => client.readContract({ address: guard, abi: guardAbi, functionName: "holders", args: [offset, BigInt(HOLDER_PAGE)], blockNumber })),
  );
  const seen = new Set<Address>();
  for (const page of pages) for (const holder of page) seen.add(getAddress(holder));
  const end = start + BigInt(PAGES_PER_RUN * HOLDER_PAGE);
  return { holders: [...seen], total, start, next: end < total ? end : 0n };
}

export type Filtered = { loans: Loan[]; dropped: { noDebt: number; noAllowance: number; unreadable: number } };

// Two cheap reads per holder and market, batched through Multicall3: the Morpho debt, and (for the keeper) the
// allowance to AdagGuard in that market's loan token. A holder with neither is dropped before any quote.
export async function readLiveLoans(client: KeeperClient, guard: Address, holders: Address[], blockNumber: bigint, needAllowance: boolean): Promise<Filtered> {
  const pairs = holders.flatMap((borrower) => GUARD_MARKETS.map((market) => ({ borrower, market })));
  const dropped = { noDebt: 0, noAllowance: 0, unreadable: 0 };
  if (pairs.length === 0) return { loans: [], dropped };

  const positions = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    blockNumber,
    contracts: pairs.map(({ borrower, market }) => ({ address: MORPHO, abi: positionAbi, functionName: "position" as const, args: [market, borrower] as const })),
  });
  const allowances = needAllowance
    ? await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: true,
        blockNumber,
        contracts: pairs.map(({ borrower, market }) => ({ address: LOAN_TOKEN[market]!, abi: allowanceAbi, functionName: "allowance" as const, args: [borrower, guard] as const })),
      })
    : null;

  const loans: Loan[] = [];
  pairs.forEach((pair, i) => {
    const position = positions[i];
    if (!position || position.status !== "success") {
      dropped.unreadable += 1;
      return;
    }
    if ((position.result as readonly [bigint, bigint, bigint])[1] === 0n) {
      dropped.noDebt += 1;
      return;
    }
    if (allowances) {
      const allowance = allowances[i];
      if (!allowance || allowance.status !== "success") {
        dropped.unreadable += 1;
        return;
      }
      if (allowance.result === 0n) {
        dropped.noAllowance += 1;
        return;
      }
    }
    loans.push(pair);
  });
  return { loans, dropped };
}

// quote is the same computation protect runs (C40), read at one pinned block for the loans that survived the filter.
export async function readQuotes(client: KeeperClient, guard: Address, loans: Loan[], blockNumber: bigint): Promise<Quote[]> {
  if (loans.length === 0) return [];
  const answers = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    blockNumber,
    contracts: loans.map(({ borrower, market }) => ({ address: guard, abi: guardAbi, functionName: "quote" as const, args: [borrower, market] as const })),
  });
  const quotes: Quote[] = [];
  answers.forEach((answer, i) => {
    if (answer.status !== "success") return;
    const [wouldAct, amount, ltvWad] = answer.result as readonly [boolean, bigint, bigint];
    quotes.push({ ...loans[i]!, wouldAct, amount, ltvWad });
  });
  return quotes;
}

export async function readRule(client: KeeperClient, guard: Address, borrower: Address, market: Hex, blockNumber?: bigint): Promise<Rule> {
  const rule = await client.readContract({ address: guard, abi: guardAbi, functionName: "ruleOf", args: [borrower, market], blockNumber });
  return { triggerWad: BigInt(rule.triggerWad), targetWad: BigInt(rule.targetWad), expiry: BigInt(rule.expiry) };
}

// If Chainlink moves a feed to a new aggregator, the webhook filter on the old one goes quiet. Every run checks.
export async function readMovedFeeds(client: KeeperClient, blockNumber: bigint): Promise<Address[]> {
  const moved: Address[] = [];
  for (const feed of FEEDS) {
    try {
      const now = await client.readContract({ address: feed.proxy, abi: feedProxyAbi, functionName: "aggregator", blockNumber });
      if (getAddress(now) !== feed.aggregator) moved.push(feed.proxy);
    } catch {
      moved.push(feed.proxy);
    }
  }
  return moved;
}
