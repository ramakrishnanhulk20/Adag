import { decodeFunctionResult, encodeFunctionData, pad, stringToHex, toHex, type Address } from "viem";
import { CIRBTC, MARKET_USDC, MORPHO, USDC, USDC_MARKET_ORACLE } from "@/lib/arc/constants";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { adagAbi, erc20Abi, m3fAbi, memoAbi, morphoAbi, oracleAbi } from "./abi";
import type { CheckId } from "./catalogue";
import { BILL_AMOUNT, DEMO_PAYEE, DEMO_PAYER, MEMO, MULTICALL3_FROM, RANDOM_TOKEN, STRANGER, WETH } from "./constants";
import {
  approve,
  btc,
  debtUp,
  mockOracleCode,
  outcome,
  overLimit,
  pct,
  STATUS,
  tidy,
  tx,
  usdc,
  usdPrice,
  verifyUsdcParams,
  type Params,
  type Pin,
  type Row,
  type Step,
} from "./kit";
import { findBillPaid, simulate, type SimBlock, type SimResult } from "./simulate";

// A TypeScript port of packages/contracts/prove-it/attack.mjs --target enrol, A1 to A9 and E1 to E5, against the
// current AdagBills. Overrides only fund the simulated stranger and, in A9 alone, swap in a mock oracle labelled
// as a simulated price drop. Adag and Morpho state are never overridden.

const ADAG: Address = ADAG_BILLS;
const STRANGER_FUNDS = { [STRANGER]: { balance: toHex(100n * 10n ** 18n) } };

export const BILL_IDS: CheckId[] = ["A1", "A2a", "A2b", "A3", "A4", "A5", "A6.1", "A6.2", "A6.3", "A6.4", "A6.5", "A7a", "A7b", "A8", "A9a", "A9b", "E1", "E2", "E3", "E4", "E5"];

const adag = {
  pay: (id: bigint): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [id] }) }),
  create: (currency: Address, amount: bigint, due: bigint, ref: `0x${string}`): Step => ({
    to: ADAG,
    data: encodeFunctionData({ abi: adagAbi, functionName: "createBill", args: [currency, amount, due, ref] }),
  }),
  void: (id: bigint): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "voidBill", args: [id] }) }),
  enrol: (): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "enrol" }) }),
  bill: (id: bigint): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "bill", args: [id] }) }),
  ltv: (): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "loanToValue", args: [DEMO_PAYER, MARKET_USDC] }) }),
  seen: (who: Address): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "seenPosition", args: [who, MARKET_USDC] }) }),
  enrolledAt: (who: Address): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "enrolledAt", args: [who] }) }),
  count: (): Step => ({ to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "billCount" }) }),
};
const morpho = {
  borrow: (p: Params, assets: bigint, shares: bigint): Step => ({
    to: MORPHO,
    data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [p, assets, shares, DEMO_PAYER, DEMO_PAYER] }),
  }),
  repayShares: (p: Params, shares: bigint): Step => ({
    to: MORPHO,
    data: encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [p, 0n, shares, DEMO_PAYER, "0x"] }),
  }),
  withdraw: (p: Params, assets: bigint): Step => ({
    to: MORPHO,
    data: encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [p, assets, DEMO_PAYER, DEMO_PAYER] }),
  }),
  supply: (p: Params, assets: bigint): Step => ({
    to: MORPHO,
    data: encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [p, assets, DEMO_PAYER, "0x"] }),
  }),
};
const memo = (inner: Step, billId: bigint, ref: string): Step => ({
  to: MEMO,
  data: encodeFunctionData({ abi: memoAbi, functionName: "memo", args: [inner.to, inner.data, pad(toHex(billId), { size: 32 }), stringToHex(ref)] }),
});
// allowFailure false on every step: one failing step reverts the whole batch.
const batch = (steps: Step[]): Step => ({
  to: MULTICALL3_FROM,
  data: encodeFunctionData({ abi: m3fAbi, functionName: "aggregate3", args: [steps.map((s) => ({ target: s.to, allowFailure: false, callData: s.data }))] }),
});
const payViaMemo = (id: bigint) => memo(adag.pay(id), id, `ATTACK-${id}`);
const cashPay = (id: bigint) => [approve(USDC, ADAG, BILL_AMOUNT), payViaMemo(id)];

const decodeBill = (r: SimResult) => decodeFunctionResult({ abi: adagAbi, functionName: "bill", data: r.returnData });
const statusOf = (r: SimResult) => (r.ok ? (STATUS[decodeBill(r).status] ?? "unknown") : "unreadable");
const seenOf = (r: SimResult) => decodeFunctionResult({ abi: adagAbi, functionName: "seenPosition", data: r.returnData });
const enrolledAtOf = (r: SimResult) => decodeFunctionResult({ abi: adagAbi, functionName: "enrolledAt", data: r.returnData });
const ltvOfRead = (r: SimResult) => (r.ok ? decodeFunctionResult({ abi: adagAbi, functionName: "loanToValue", data: r.returnData }) : null);

type Ctx = {
  setup: SimBlock[];
  offset: number;
  paidId: bigint;
  params: Params;
  shares: bigint;
  collateral: bigint;
  debt: bigint;
  value: bigint;
  price: bigint;
  baseFeed: Address;
  quoteFeed: Address;
  ltv: bigint;
  count: bigint;
  seen: readonly [bigint, bigint];
};

export async function runBills(pin: Pin, row: Row, state: (lines: string[]) => void): Promise<void> {
  const ctx = { setup: [] as SimBlock[], offset: 0, paidId: 1n } as Ctx;
  const t = (k: number) => pin.timestamp + BigInt(ctx.offset + k);
  const sim = async (blocks: SimBlock[]) => {
    const res = await simulate([...ctx.setup, ...blocks], pin.number);
    for (const blk of res.slice(0, ctx.setup.length)) {
      const bad = blk.find((r) => !r.ok);
      if (bad) throw new Error(`setup block failed: ${outcome(bad)}`);
    }
    return res.slice(ctx.setup.length);
  };
  const reads = async (steps: Step[]) => {
    const res = await sim([{ time: t(1), calls: steps.map((s) => tx(DEMO_PAYER, s)) }]);
    const bad = res[0]!.findIndex((r) => !r.ok);
    if (bad >= 0) throw new Error(`baseline read ${bad + 1} failed: ${outcome(res[0]![bad]!)}`);
    return res[0]!;
  };
  const newBills = (n: number): SimBlock => ({
    time: t(1),
    calls: Array.from({ length: n }, (_, i) => tx(DEMO_PAYEE, adag.create(USDC, BILL_AMOUNT, t(1) + 86_400n, stringToHex(`ATTACK-BILL-${i + 1}`)))),
  });
  const written = (res: SimResult[]) => {
    const bad = res.find((r) => !r.ok);
    if (bad) throw new Error(`setup createBill failed: ${outcome(bad)}`);
  };
  const firstNewId = () => ctx.count + 1n;

  const [pRes] = await reads([{ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "idToMarketParams", args: [MARKET_USDC] }) }]);
  const p = decodeFunctionResult({ abi: morphoAbi, functionName: "idToMarketParams", data: pRes!.returnData });
  ctx.params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  verifyUsdcParams(ctx.params);

  // The live state these attacks assume: a bill the demo wallet paid, and its loan as Adag last recorded it. When the
  // loan has moved since (the loan guard's live proof repaid part of it outside Adag), one setup block writes a bill
  // and pays it from cash, which records the loan as it stands, exactly as attack.mjs does.
  const before = await reads([
    adag.count(),
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [MARKET_USDC, DEMO_PAYER] }) },
    adag.seen(DEMO_PAYER),
    adag.bill(1n),
  ]);
  const count0 = decodeFunctionResult({ abi: adagAbi, functionName: "billCount", data: before[0]!.returnData });
  const pos0 = decodeFunctionResult({ abi: morphoAbi, functionName: "position", data: before[1]!.returnData });
  const seen0 = seenOf(before[2]!);
  const bill1 = decodeBill(before[3]!);
  const recorded = seen0[0] === BigInt(pos0[1]) && seen0[1] === BigInt(pos0[2]);
  if (!(bill1.status === 2 && bill1.payer.toLowerCase() === DEMO_PAYER.toLowerCase() && recorded)) {
    const id = count0 + 1n;
    const time = pin.timestamp + 1n;
    ctx.setup = [
      {
        time,
        calls: [
          tx(DEMO_PAYEE, adag.create(USDC, BILL_AMOUNT, time + 86_400n, stringToHex("ATTACK-SETUP"))),
          tx(DEMO_PAYER, batch([approve(USDC, ADAG, BILL_AMOUNT), memo(adag.pay(id), id, "ATTACK-SETUP")])),
        ],
      },
    ];
    ctx.offset = 1;
    ctx.paidId = id;
  }

  const r = await reads([
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [MARKET_USDC, DEMO_PAYER] }) },
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "market", args: [MARKET_USDC] }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "price" }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "BASE_FEED_1" }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "QUOTE_FEED_1" }) },
    adag.seen(DEMO_PAYER),
    adag.bill(ctx.paidId),
    adag.count(),
    adag.ltv(),
    { to: ADAG, data: encodeFunctionData({ abi: adagAbi, functionName: "priceStatus", args: [MARKET_USDC] }) },
    { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [DEMO_PAYER] }) },
    { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [DEMO_PAYER, ADAG] }) },
  ]);
  const pos = decodeFunctionResult({ abi: morphoAbi, functionName: "position", data: r[0]!.returnData });
  const market = decodeFunctionResult({ abi: morphoAbi, functionName: "market", data: r[1]!.returnData });
  ctx.price = decodeFunctionResult({ abi: oracleAbi, functionName: "price", data: r[2]!.returnData });
  ctx.baseFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "BASE_FEED_1", data: r[3]!.returnData });
  ctx.quoteFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "QUOTE_FEED_1", data: r[4]!.returnData });
  ctx.seen = seenOf(r[5]!);
  const paidBill = decodeBill(r[6]!);
  ctx.count = decodeFunctionResult({ abi: adagAbi, functionName: "billCount", data: r[7]!.returnData });
  ctx.ltv = decodeFunctionResult({ abi: adagAbi, functionName: "loanToValue", data: r[8]!.returnData });
  const status = decodeFunctionResult({ abi: adagAbi, functionName: "priceStatus", data: r[9]!.returnData });
  const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r[10]!.returnData });
  const allowance = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: r[11]!.returnData });
  ctx.shares = BigInt(pos[1]);
  ctx.collateral = BigInt(pos[2]);
  ctx.debt = debtUp(ctx.shares, BigInt(market[2]), BigInt(market[3]));
  ctx.value = (ctx.collateral * ctx.price) / 10n ** 36n;

  const problems: string[] = [];
  if (ctx.shares === 0n) problems.push("the demo wallet has no open USDC-market loan");
  if (ctx.seen[0] !== ctx.shares || ctx.seen[1] !== ctx.collateral) problems.push("the demo loan has moved since Adag last recorded it");
  if (paidBill.status !== 2) problems.push(`bill #${ctx.paidId} is not Paid`);
  if (!status[0]) problems.push("the BTC/USD price is stale, so every loan check would stop at StalePrice first");
  if (allowance !== 0n) problems.push("the demo wallet still has a USDC allowance to Adag");
  if (balance < 2_000000n) problems.push("the demo wallet holds under 2 USDC, too little to repay and re-borrow in A2");
  if (problems.length) throw new Error(`The live state is not the one these attacks were written for: ${problems.join("; ")}.`);

  state([
    `AdagBills ${ADAG}. Demo wallet ${DEMO_PAYER}: loan ${usdc(ctx.debt)} against ${btc(ctx.collateral)} pledged, loan-to-value ${pct(ctx.ltv)}.`,
    ctx.setup.length
      ? `Setup block before every simulation: the supplier writes bill #${ctx.paidId} and the demo wallet pays it from cash, so Adag records the loan as it stands today.`
      : `Bill #${ctx.paidId} is paid by the demo wallet, and Adag's record of its loan is current.`,
    `Supplier ${DEMO_PAYEE}. Simulated stranger ${STRANGER}. Bitcoin at ${usdPrice(ctx.price)} USDC, from the USDC market's oracle.`,
  ]);

  const A1 = async () => {
    const res = await sim([{ time: t(1), overrides: STRANGER_FUNDS, calls: [tx(STRANGER, approve(USDC, ADAG, 1_000000n)), tx(STRANGER, adag.pay(ctx.paidId))] }]);
    const x = res[0]![1]!;
    const pass = res[0]![0]!.ok && !x.ok && outcome(x) === `BillNotOpen(${ctx.paidId}, 2)`;
    row("A1", pass, pass ? `Refused. Bill #${ctx.paidId} is already paid, and a paid bill can never be paid again.` : `Not refused as expected: ${tidy(outcome(x))}.`, outcome(x), x.gas);
  };

  const closeAndRepledge = async (repledge: bigint, extraBlocks: SimBlock[], id: bigint) => {
    const repayApproval = ctx.debt + ctx.debt / 1000n + 1n;
    const res = await sim([
      newBills(1),
      ...extraBlocks,
      {
        time: t(2 + extraBlocks.length),
        calls: [
          tx(
            DEMO_PAYER,
            batch([
              approve(USDC, MORPHO, repayApproval),
              morpho.repayShares(ctx.params, ctx.shares),
              morpho.withdraw(ctx.params, ctx.collateral),
              approve(CIRBTC, MORPHO, repledge),
              morpho.supply(ctx.params, repledge),
              morpho.borrow(ctx.params, 0n, ctx.shares),
              ...cashPay(id),
            ]),
          ),
          tx(DEMO_PAYER, adag.bill(id)),
        ],
      },
    ]);
    written(res[0]!);
    const last = res[res.length - 1]!;
    return { res, r: last[0]!, status: statusOf(last[1]!) };
  };
  // Enough collateral that Morpho allows the loan (about 60%), so only Adag's 40% line stands in the way.
  const sixty = () => (ctx.debt * 10n ** 36n * 10n + ctx.price * 6n - 1n) / (ctx.price * 6n);

  const A2 = async () => {
    const quarter = ctx.collateral / 4n;
    const a = await closeAndRepledge(quarter, [], firstNewId());
    const aOut = outcome(a.r);
    const aPass = !a.r.ok && /insufficient collateral|LtvAboveLimit/.test(aOut) && a.status === "Open";
    row(
      "A2a",
      aPass,
      aPass
        ? `Refused by Morpho before Adag was reached: re-borrowing against ${btc(quarter)} would put the loan near ${pct(ctx.ltv * 4n)}, past Morpho's 86% line. The bill stays open.`
        : `Not refused as expected: ${tidy(aOut)}; bill ${a.status}.`,
      `${aOut}; bill ${a.status}`,
      a.r.gas,
    );
    const b = await closeAndRepledge(sixty(), [], firstNewId());
    const bOut = outcome(b.r);
    const bPass = !b.r.ok && bOut.startsWith("MemoFailed(LtvAboveLimit(") && b.status === "Open";
    row(
      "A2b",
      bPass,
      bPass ? `Refused by Adag: the pledge fell to ${btc(sixty())} since its last check, so it checked, and ${overLimit(bOut)}. The whole batch undid itself.` : `Not refused as expected: ${tidy(bOut)}; bill ${b.status}.`,
      `${bOut}; bill ${b.status}`,
      b.r.gas,
    );
  };

  const A3 = async () => {
    const id = firstNewId();
    const extra = ctx.value / 2n - ctx.debt;
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYER, batch([morpho.borrow(ctx.params, extra, 0n), ...cashPay(id)])), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const x = res[1]![0]!;
    const st = statusOf(res[1]![1]!);
    const out = outcome(x);
    const pass = !x.ok && out.startsWith("MemoFailed(LtvAboveLimit(") && st === "Open";
    row("A3", pass, pass ? `Refused by Adag: borrowing ${usdc(extra)} more is new debt, so it checked, and ${overLimit(out)}.` : `Not refused as expected: ${tidy(out)}; bill ${st}.`, `${out}; bill ${st}`, x.gas);
  };

  // The named residual: debt taken after the Adag step in the same batch is not seen by that payment. It is seen
  // by the next one, which is refused until the loan is back under 40%.
  const A4 = async () => {
    const idA = firstNewId();
    const idB = idA + 1n;
    const extra = (ctx.value * 6n) / 10n - ctx.debt;
    const res = await sim([
      newBills(2),
      { time: t(2), calls: [tx(DEMO_PAYER, batch([...cashPay(idA), morpho.borrow(ctx.params, extra, 0n)])), tx(DEMO_PAYER, adag.ltv())] },
      { time: t(3), calls: [tx(DEMO_PAYER, batch(cashPay(idB))), tx(DEMO_PAYER, adag.bill(idB))] },
    ]);
    written(res[0]!);
    const first = res[1]![0]!;
    const paid = first.ok ? findBillPaid(first.logs, ADAG) : null;
    const ltvAfter = ltvOfRead(res[1]![1]!);
    const second = res[2]![0]!;
    const stB = statusOf(res[2]![1]!);
    const secondOut = outcome(second);
    const pass = first.ok && paid?.loanChecked === false && !second.ok && secondOut.startsWith("MemoFailed(LtvAboveLimit(") && stB === "Open";
    row(
      "A4",
      pass,
      pass
        ? `The first payment went through, because the ${usdc(extra)} borrow came after Adag's step, leaving the loan at ${ltvAfter === null ? "an unreadable level" : pct(ltvAfter)}. The next payment was refused: ${overLimit(secondOut)}.`
        : `Did not behave as documented: first ${first.ok ? `success, loanChecked ${paid?.loanChecked}` : tidy(outcome(first))}; next ${tidy(secondOut)}; bill ${stB}.`,
      `first: ${first.ok ? `success, loanChecked ${paid?.loanChecked}, loan-to-value then ${ltvAfter === null ? "?" : pct(ltvAfter)}` : outcome(first)}; next: ${secondOut}; bill ${stB}`,
      second.gas,
    );
  };

  const A5 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYEE, adag.pay(id))] }]);
    written(res[0]!);
    const x = res[1]![0]!;
    const pass = !x.ok && outcome(x) === "SelfPayment()";
    row("A5", pass, pass ? "Refused. A supplier cannot pay its own bill: no money would change hands, so nothing would prove it was paid." : `Not refused as expected: ${tidy(outcome(x))}.`, outcome(x), x.gas);
  };

  const A6 = async () => {
    const due = t(1) + 86_400n;
    const cases: [CheckId, Step, string, string][] = [
      ["A6.1", adag.create(CIRBTC, BILL_AMOUNT, due, "0x"), `UnsupportedCurrency(${CIRBTC})`, "Refused. Bills are paid in USDC or EURC; cirBTC is the collateral, never the currency."],
      ["A6.2", adag.create(WETH, BILL_AMOUNT, due, "0x"), `UnsupportedCurrency(${WETH})`, "Refused. WETH is not one of the two currencies Adag accepts."],
      ["A6.3", adag.create(RANDOM_TOKEN, BILL_AMOUNT, due, "0x"), `UnsupportedCurrency(${RANDOM_TOKEN})`, "Refused. An address that is not USDC or EURC can never be a bill's currency."],
      ["A6.4", adag.create(USDC, 0n, due, "0x"), "ZeroAmount()", "Refused. A bill for zero is not a bill."],
      ["A6.5", adag.create(USDC, BILL_AMOUNT, due, stringToHex("x".repeat(141))), "ReferenceTooLong(141)", "Refused. The reference is 141 bytes and the limit is 140, counted in bytes, not characters."],
    ];
    const res = await sim([{ time: t(1), overrides: STRANGER_FUNDS, calls: cases.map(([, s]) => tx(STRANGER, s)) }]);
    cases.forEach(([id, , want, plain], i) => {
      const x = res[0]![i]!;
      const pass = !x.ok && outcome(x) === want;
      row(id, pass, pass ? plain : `Not refused as expected: ${tidy(outcome(x))}.`, outcome(x), x.gas);
    });
  };

  const A7 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), overrides: STRANGER_FUNDS, calls: [tx(STRANGER, adag.void(id)), tx(DEMO_PAYEE, adag.void(ctx.paidId)), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const [stranger, paidVoid, read] = res[1]! as [SimResult, SimResult, SimResult];
    const st = statusOf(read);
    const aPass = !stranger.ok && outcome(stranger) === `NotPayee(${STRANGER})` && st === "Open";
    row("A7a", aPass, aPass ? "Refused. Only the supplier who wrote a bill can cancel it; the bill stays open and payable." : `Not refused as expected: ${tidy(outcome(stranger))}; bill ${st}.`, `${outcome(stranger)}; bill ${st}`, stranger.gas);
    const bPass = !paidVoid.ok && outcome(paidVoid) === `BillNotOpen(${ctx.paidId}, 2)`;
    row("A7b", bPass, bPass ? `Refused. Bill #${ctx.paidId} is paid, and a paid bill can never be cancelled.` : `Not refused as expected: ${tidy(outcome(paidVoid))}.`, outcome(paidVoid), paidVoid.gas);
  };

  const A8 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYER, batch([payViaMemo(id)])), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const x = res[1]![0]!;
    const st = statusOf(res[1]![1]!);
    const pass = !x.ok && st === "Open";
    row("A8", pass, pass ? "Refused. The USDC token would not move money Adag was never approved to move, so the whole batch undid itself and the bill stays open." : `Not refused as expected: ${tidy(outcome(x))}; bill ${st}.`, `${outcome(x)}; bill ${st}`, x.gas);
  };

  // SIMULATED PRICE DROP: the mock oracle replaces the USDC market's oracle with a price 25% lower, from the second
  // simulated block on. Morpho and Adag both see it.
  const A9 = async () => {
    const id = firstNewId();
    const mock = { [ctx.params.oracle]: { code: mockOracleCode((ctx.price * 75n) / 100n, ctx.baseFeed, ctx.quoteFeed) } };
    const cash = await sim([newBills(1), { time: t(2), overrides: mock, calls: [tx(DEMO_PAYER, adag.ltv()), tx(DEMO_PAYER, batch(cashPay(id)))] }]);
    written(cash[0]!);
    const ltvNow = ltvOfRead(cash[1]![0]!);
    const c = cash[1]![1]!;
    const paid = c.ok ? findBillPaid(c.logs, ADAG) : null;
    const aPass = c.ok && paid?.loanChecked === false;
    row(
      "A9a",
      aPass,
      aPass
        ? `Paid, as promised. After the simulated drop the loan sits at ${ltvNow === null ? "an unreadable level" : pct(ltvNow)}, but this payment adds no debt, so there is nothing to check.`
        : `Did not behave as promised: ${c.ok ? `success, loanChecked ${paid?.loanChecked}` : tidy(outcome(c))}.`,
      c.ok ? `success, loanChecked ${paid?.loanChecked}` : outcome(c),
      c.gas,
    );
    const loan = await sim([newBills(1), { time: t(2), overrides: mock, calls: [tx(DEMO_PAYER, batch([morpho.borrow(ctx.params, 10_000n, 0n), ...cashPay(id)])), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(loan[0]!);
    const l = loan[1]![0]!;
    const st = statusOf(loan[1]![1]!);
    const out = outcome(l);
    const bPass = !l.ok && out.startsWith("MemoFailed(LtvAboveLimit(") && st === "Open";
    row("A9b", bPass, bPass ? `Refused by Adag: one more cent is new debt, so it checked, and ${overLimit(out)}.` : `Not refused as expected: ${tidy(out)}; bill ${st}.`, `${out}; bill ${st}`, l.gas);
  };

  const sameSeen = (s: readonly [bigint, bigint]) => s[0] === ctx.seen[0] && s[1] === ctx.seen[1];
  const recordText = (s: readonly [bigint, bigint]) => `${s[0]} shares, ${btc(s[1])}`;

  const E1 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYER, batch([adag.enrol(), ...cashPay(id)])), tx(DEMO_PAYER, adag.bill(id)), tx(DEMO_PAYER, adag.enrolledAt(DEMO_PAYER))] }]);
    written(res[0]!);
    const [x, bill, at] = res[1]! as [SimResult, SimResult, SimResult];
    const st = statusOf(bill);
    const block = enrolledAtOf(at);
    const pass = !x.ok && outcome(x) === "MemoFailed(EnrolledThisBlock())" && st === "Open" && block === 0n;
    row(
      "E1",
      pass,
      pass ? "Refused. A payer who enrolled in this very block cannot pay in it, so the whole batch undid itself, the enrol included." : `Not refused as expected: ${tidy(outcome(x))}; bill ${st}; enrol block ${block}.`,
      `${outcome(x)}; bill ${st}; enrol block after ${block}`,
      x.gas,
    );
  };

  const E2 = async () => {
    const id = firstNewId();
    const extra = (ctx.value * 6n) / 10n - ctx.debt;
    const res = await sim([
      newBills(1),
      { time: t(2), calls: [tx(DEMO_PAYER, batch([morpho.borrow(ctx.params, extra, 0n), adag.enrol(), ...cashPay(id)])), tx(DEMO_PAYER, adag.bill(id)), tx(DEMO_PAYER, adag.seen(DEMO_PAYER))] },
    ]);
    written(res[0]!);
    const [x, bill, seen] = res[1]! as [SimResult, SimResult, SimResult];
    const st = statusOf(bill);
    const s = seenOf(seen);
    const pass = !x.ok && outcome(x) === "MemoFailed(EnrolledThisBlock())" && st === "Open" && sameSeen(s);
    row(
      "E2",
      pass,
      pass ? `Refused. Borrowing ${usdc(extra)}, enrolling it and paying in one batch hits the same-block refusal; Adag's record of the loan is unchanged.` : `Not refused as expected: ${tidy(outcome(x))}; bill ${st}.`,
      `${outcome(x)}; bill ${st}; recorded position ${recordText(s)}`,
      x.gas,
    );
  };

  const E3 = async () => {
    const id = firstNewId();
    const res = await sim([
      newBills(1),
      {
        time: t(2),
        overrides: STRANGER_FUNDS,
        calls: [
          tx(DEMO_PAYER, adag.seen(DEMO_PAYER)),
          tx(STRANGER, adag.enrol()),
          tx(DEMO_PAYER, adag.seen(DEMO_PAYER)),
          tx(DEMO_PAYER, adag.enrolledAt(DEMO_PAYER)),
          tx(DEMO_PAYER, adag.enrolledAt(STRANGER)),
          tx(DEMO_PAYER, batch(cashPay(id))),
        ],
      },
    ]);
    written(res[0]!);
    const [before, enrol, after, demoAt, strangerAt, pay] = res[1]! as SimResult[];
    const b = seenOf(before!);
    const a = seenOf(after!);
    const dAt = enrolledAtOf(demoAt!);
    const sAt = enrolledAtOf(strangerAt!);
    const pass = enrol!.ok && sAt === pin.number + BigInt(ctx.offset + 2) && sameSeen(b) && sameSeen(a) && dAt === 0n && pay!.ok;
    row(
      "E3",
      pass,
      pass
        ? `Held. The stranger's enrol went through but wrote only the stranger's own record; the demo payer's recorded loan did not change, and its payment went through.`
        : `Did not behave as documented: stranger enrol ${outcome(enrol!)}; demo record ${recordText(b)} before, ${recordText(a)} after; demo payment ${outcome(pay!)}.`,
      `stranger enrol ${outcome(enrol!)} (its enrol block ${sAt}); demo recorded ${recordText(b)} before and ${recordText(a)} after; demo enrol block ${dAt}; demo payment ${outcome(pay!)}`,
      enrol!.gas,
    );
  };

  // The bypass the backend review found, against an enrolled position: enrol in block N, then in N+1 close the loan
  // outside Adag, re-pledge enough for about 60% and borrow back exactly the enrolled share count.
  const E4 = async () => {
    const id = firstNewId();
    const { res, r: x, status: st } = await closeAndRepledge(sixty(), [{ time: t(2), calls: [tx(DEMO_PAYER, adag.enrol())] }], id);
    const enrol = res[1]![0]!;
    const out = outcome(x);
    const pass = enrol.ok && !x.ok && out.startsWith("MemoFailed(LtvAboveLimit(") && st === "Open";
    row(
      "E4",
      pass,
      pass ? `Refused by Adag: the pledge fell below the enrolled one, so it checked, and ${overLimit(out)}.` : `Not refused as expected: enrol ${outcome(enrol)}; then ${tidy(out)}; bill ${st}.`,
      `enrol ${outcome(enrol)}; then ${out}; bill ${st}`,
      x.gas,
    );
  };

  // The residual C32 names: debt taken outside Adag and enrolled in block N is not checked by a payment in N+1.
  const E5 = async () => {
    const id = firstNewId();
    const extra = (ctx.value * 6n) / 10n - ctx.debt;
    const res = await sim([
      newBills(1),
      { time: t(2), calls: [tx(DEMO_PAYER, morpho.borrow(ctx.params, extra, 0n)), tx(DEMO_PAYER, adag.enrol()), tx(DEMO_PAYER, adag.ltv())] },
      { time: t(3), calls: [tx(DEMO_PAYER, batch(cashPay(id))), tx(DEMO_PAYER, adag.bill(id))] },
    ]);
    written(res[0]!);
    const [borrow, enrol, ltvRead] = res[1]! as [SimResult, SimResult, SimResult];
    const [pay, bill] = res[2]! as [SimResult, SimResult];
    const paid = pay.ok ? findBillPaid(pay.logs, ADAG) : null;
    const ltv = ltvOfRead(ltvRead);
    const st = statusOf(bill);
    const pass = borrow.ok && enrol.ok && pay.ok && paid?.loanChecked === false && st === "Paid";
    row(
      "E5",
      pass,
      pass
        ? `Allowed by design, as C32 names it: the ${usdc(extra)} borrowed outside Adag (loan at ${ltv === null ? "?" : pct(ltv)}) was enrolled, and the next block's cash payment went through unchecked. The risk sits only with the payer's own loan.`
        : `Did not behave as documented: borrow ${outcome(borrow)}; enrol ${outcome(enrol)}; payment ${pay.ok ? `success, loanChecked ${paid?.loanChecked}` : tidy(outcome(pay))}; bill ${st}.`,
      `borrow ${outcome(borrow)}, loan-to-value ${ltv === null ? "?" : pct(ltv)}; enrol ${outcome(enrol)}; next block: ${pay.ok ? `success, loanChecked ${paid?.loanChecked}` : outcome(pay)}; bill ${st}`,
      pay.gas,
    );
  };

  const attacks: [() => Promise<void>, CheckId[]][] = [
    [A1, ["A1"]],
    [A2, ["A2a", "A2b"]],
    [A3, ["A3"]],
    [A4, ["A4"]],
    [A5, ["A5"]],
    [A6, ["A6.1", "A6.2", "A6.3", "A6.4", "A6.5"]],
    [A7, ["A7a", "A7b"]],
    [A8, ["A8"]],
    [A9, ["A9a", "A9b"]],
    [E1, ["E1"]],
    [E2, ["E2"]],
    [E3, ["E3"]],
    [E4, ["E4"]],
    [E5, ["E5"]],
  ];
  await runEach(attacks, row);
}

// C19: an attack that could not run is reported as such, never as refused.
export async function runEach(attacks: [() => Promise<void>, CheckId[]][], row: Row & { done?: Set<CheckId> }) {
  for (const [attack, ids] of attacks) {
    try {
      await attack();
    } catch (e) {
      const reason = `could not run: ${((e as Error).message || "unknown error").slice(0, 200)}`;
      for (const id of ids) row(id, false, reason, reason, null);
    }
  }
}
