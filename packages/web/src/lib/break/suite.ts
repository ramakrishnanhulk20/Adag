import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  pad,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ADAG_BILLS, ADAPTIVE_CURVE_IRM, CHAIN_ID, CIRBTC, MARKET_USDC, MORPHO, USDC, USDC_MARKET_LLTV, USDC_MARKET_ORACLE } from "@/lib/arc/constants";
import { adagAbi, erc20Abi, m3fAbi, memoAbi, morphoAbi, oracleAbi } from "./abi";
import { CHECKS, type CheckId, type CheckResult, type RunLine } from "./catalogue";
import { BILL_AMOUNT, DEMO_PAYEE, DEMO_PAYER, MEMO, MOCK_ORACLE_CODE, MULTICALL3_FROM, RANDOM_TOKEN, STRANGER, WETH } from "./constants";
import { decodeRevert, findBillPaid, simChainId, simHead, simulate, type Call, type SimBlock, type SimResult } from "./simulate";

// A TypeScript port of packages/contracts/prove-it/attack.mjs, A1 to A9, with the same actors, the same state
// overrides and the same pass rules. Overrides only fund the simulated stranger, and in A9 alone swap in a mock
// oracle labelled as a simulated price drop. Adag and Morpho state are never overridden.

const STATUS = ["None", "Open", "Paid", "Void"] as const;
const STRANGER_FUNDS = { [STRANGER]: { balance: toHex(100n * 10n ** 18n) } };

type Params = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
type Step = { to: Address; data: Hex };

type Ctx = {
  pin: { number: bigint; timestamp: bigint };
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
};

const fixed = (v: bigint, decimals: number) => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  return `${neg ? "-" : ""}${abs / scale}.${(abs % scale).toString().padStart(decimals, "0")}`;
};
const usdc = (v: bigint) => `${fixed(v, 6)} USDC`;
const btc = (v: bigint) => `${fixed(v, 8)} cirBTC`;
const pct = (wad: bigint) => (wad === 2n ** 256n - 1n ? "no collateral" : `${(Number(wad) / 1e16).toFixed(2)}%`);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const approve = (token: Address, spender: Address, amount: bigint): Step => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
const adag = {
  pay: (id: bigint): Step => ({ to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [id] }) }),
  create: (currency: Address, amount: bigint, due: bigint, ref: Hex): Step => ({
    to: ADAG_BILLS,
    data: encodeFunctionData({ abi: adagAbi, functionName: "createBill", args: [currency, amount, due, ref] }),
  }),
  void: (id: bigint): Step => ({ to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "voidBill", args: [id] }) }),
  bill: (id: bigint): Step => ({ to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "bill", args: [id] }) }),
  ltv: (): Step => ({ to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "loanToValue", args: [DEMO_PAYER, MARKET_USDC] }) }),
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
const tx = (from: Address, s: Step): Call => ({ from, to: s.to, data: s.data });

const payViaMemo = (id: bigint) => memo(adag.pay(id), id, `ATTACK-${id}`);
const cashPay = (id: bigint) => [approve(USDC, ADAG_BILLS, BILL_AMOUNT), payViaMemo(id)];

const outcome = (r: SimResult) => (r.ok ? "success" : decodeRevert(r.revertData));
const tidy = (s: string) =>
  s
    .split(MARKET_USDC)
    .join("MARKET_USDC")
    .replace(/BillNotOpen\((\d+), (\d)\)/g, (_, id: string, st: string) => `BillNotOpen(${id}, ${STATUS[Number(st)] ?? st})`);
const statusOf = (r: SimResult) => {
  if (!r.ok) return "unreadable";
  const b = decodeFunctionResult({ abi: adagAbi, functionName: "bill", data: r.returnData });
  return STATUS[b.status] ?? String(b.status);
};

// "MemoFailed(LtvAboveLimit(m, borrowed, max))" in plain words, with both figures in USDC.
function overLimit(raw: string): string | null {
  const m = /LtvAboveLimit\([^,]+, (\d+), (\d+)\)/.exec(raw);
  if (!m) return null;
  return `the loan would be ${usdc(BigInt(m[1]!))} against a limit of ${usdc(BigInt(m[2]!))}, which is 40% of the bitcoin's value`;
}

function verifyParams(p: Params) {
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    ),
  );
  const same =
    id.toLowerCase() === MARKET_USDC.toLowerCase() &&
    isAddressEqual(p.loanToken, USDC) &&
    isAddressEqual(p.collateralToken, CIRBTC) &&
    isAddressEqual(p.oracle, USDC_MARKET_ORACLE) &&
    isAddressEqual(p.irm, ADAPTIVE_CURVE_IRM) &&
    p.lltv === USDC_MARKET_LLTV;
  if (!same) throw new Error("Morpho's USDC market params do not match the fixed market.");
}

// Runtime code for the mock oracle: a fixed price, and the real oracle's feeds so Adag's freshness check still reads Chainlink.
function mockOracleCode(price: bigint, baseFeed: Address, quoteFeed: Address): Hex {
  const swap = (code: string, sentinel: string, value: string) => {
    if (code.split(sentinel).length !== 2) throw new Error(`MockOracle sentinel ${sentinel.slice(0, 8)} not found exactly once.`);
    return code.replace(sentinel, value);
  };
  let code = MOCK_ORACLE_CODE.toLowerCase();
  code = swap(code, "5eed".repeat(16), price.toString(16).padStart(64, "0"));
  code = swap(code, "b0".repeat(20), baseFeed.slice(2).toLowerCase());
  code = swap(code, "c0".repeat(20), quoteFeed.slice(2).toLowerCase());
  return code as Hex;
}

export async function runSuite(emit: (line: RunLine) => void): Promise<void> {
  const chain = await simChainId();
  if (chain !== CHAIN_ID) throw new Error(`dRPC reports chain ${chain}, not Arc mainnet ${CHAIN_ID}.`);
  const pin = await simHead();
  const t = (k: number) => pin.timestamp + BigInt(k);
  const sim = (blocks: SimBlock[]) => simulate(blocks, pin.number);
  emit({ type: "start", block: pin.number.toString(), timestamp: Number(pin.timestamp), total: CHECKS.length, cached: false, ageSeconds: 0 });

  const readAll = async (steps: Step[]): Promise<SimResult[]> => {
    const res = await sim([{ time: t(1), calls: steps.map((s) => tx(DEMO_PAYER, s)) }]);
    const bad = res[0]!.findIndex((r) => !r.ok);
    if (bad >= 0) throw new Error(`baseline read ${bad + 1} failed: ${outcome(res[0]![bad]!)}`);
    return res[0]!;
  };

  const [pRes] = await readAll([{ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "idToMarketParams", args: [MARKET_USDC] }) }]);
  const p = decodeFunctionResult({ abi: morphoAbi, functionName: "idToMarketParams", data: pRes!.returnData });
  const params: Params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  verifyParams(params);

  const reads = await readAll([
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [MARKET_USDC, DEMO_PAYER] }) },
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "market", args: [MARKET_USDC] }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "price" }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "BASE_FEED_1" }) },
    { to: USDC_MARKET_ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: "QUOTE_FEED_1" }) },
    { to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "seenPosition", args: [DEMO_PAYER, MARKET_USDC] }) },
    adag.bill(1n),
    { to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "billCount" }) },
    adag.ltv(),
    { to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "priceStatus", args: [MARKET_USDC] }) },
    { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [DEMO_PAYER] }) },
    { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [DEMO_PAYER, ADAG_BILLS] }) },
  ]);
  const pos = decodeFunctionResult({ abi: morphoAbi, functionName: "position", data: reads[0]!.returnData });
  const market = decodeFunctionResult({ abi: morphoAbi, functionName: "market", data: reads[1]!.returnData });
  const price = decodeFunctionResult({ abi: oracleAbi, functionName: "price", data: reads[2]!.returnData });
  const baseFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "BASE_FEED_1", data: reads[3]!.returnData });
  const quoteFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "QUOTE_FEED_1", data: reads[4]!.returnData });
  const seen = decodeFunctionResult({ abi: adagAbi, functionName: "seenPosition", data: reads[5]!.returnData });
  const bill1 = decodeFunctionResult({ abi: adagAbi, functionName: "bill", data: reads[6]!.returnData });
  const count = decodeFunctionResult({ abi: adagAbi, functionName: "billCount", data: reads[7]!.returnData });
  const ltv = decodeFunctionResult({ abi: adagAbi, functionName: "loanToValue", data: reads[8]!.returnData });
  const status = decodeFunctionResult({ abi: adagAbi, functionName: "priceStatus", data: reads[9]!.returnData });
  const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: reads[10]!.returnData });
  const allowance = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: reads[11]!.returnData });

  const shares = BigInt(pos[1]);
  const collateral = BigInt(pos[2]);
  const debt = ceilDiv(shares * (BigInt(market[2]) + 1n), BigInt(market[3]) + 1_000_000n);
  const ctx: Ctx = {
    pin,
    params,
    shares,
    collateral,
    debt,
    value: (collateral * price) / 10n ** 36n,
    price,
    baseFeed,
    quoteFeed,
    ltv,
    count,
  };

  const problems: string[] = [];
  if (shares === 0n) problems.push("the demo wallet has no open USDC-market loan");
  if (seen[0] !== shares || seen[1] !== collateral) problems.push("the demo loan has moved since Adag last recorded it");
  if (bill1.status !== 2) problems.push("bill #1 is not Paid");
  if (!status[0]) problems.push("the BTC/USD price is stale, so every loan check would stop at StalePrice first");
  if (allowance !== 0n) problems.push("the demo wallet still has a USDC allowance to Adag");
  if (balance < 2_000000n) problems.push("the demo wallet holds under 2 USDC, too little to repay and re-borrow in A2");
  if (problems.length) throw new Error(`The live state is not the one these attacks were written for: ${problems.join("; ")}.`);

  emit({
    type: "state",
    lines: [
      `Demo wallet ${DEMO_PAYER}: loan ${usdc(debt)} against ${btc(collateral)} pledged, loan-to-value ${pct(ltv)}.`,
      `Supplier ${DEMO_PAYEE}. Simulated stranger ${STRANGER}. ${count} bill${count === 1n ? "" : "s"} written; bill #1 is ${STATUS[bill1.status]}.`,
      `Bitcoin at ${(Number(price) / 1e34).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC, from the USDC market's oracle.`,
    ],
  });

  const done = new Set<CheckId>();
  const row = (id: CheckId, pass: boolean, reason: string, raw: string, gas: bigint | null) => {
    const info = CHECKS.find((c) => c.id === id)!;
    done.add(id);
    const result: CheckResult = { id, pass, verdict: pass ? info.expect : "broken", reason, raw: tidy(raw), gas: gas === null ? null : gas.toString() };
    emit({ type: "result", result });
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

  const A1 = async () => {
    const res = await sim([{ time: t(1), overrides: STRANGER_FUNDS, calls: [tx(STRANGER, approve(USDC, ADAG_BILLS, 1_000000n)), tx(STRANGER, adag.pay(1n))] }]);
    const r = res[0]![1]!;
    const pass = res[0]![0]!.ok && !r.ok && outcome(r) === "BillNotOpen(1, 2)";
    row("A1", pass, pass ? "Refused. Bill #1 is already paid, and a paid bill can never be paid again." : `Not refused as expected: ${tidy(outcome(r))}.`, outcome(r), r.gas);
  };

  const A2 = async () => {
    const id = firstNewId();
    const repayApproval = ctx.debt + ctx.debt / 1000n + 1n;
    const run = async (repledge: bigint) => {
      const res = await sim([
        newBills(1),
        {
          time: t(2),
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
      return { r: res[1]![0]!, status: statusOf(res[1]![1]!) };
    };

    const quarter = ctx.collateral / 4n;
    const a = await run(quarter);
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

    // Enough collateral that Morpho allows the loan (about 60%), so only Adag's 40% line stands in the way.
    const sixty = (ctx.debt * 10n ** 36n * 10n + ctx.price * 6n - 1n) / (ctx.price * 6n);
    const b = await run(sixty);
    const bOut = outcome(b.r);
    const bPass = !b.r.ok && bOut.startsWith("MemoFailed(LtvAboveLimit(") && b.status === "Open";
    row(
      "A2b",
      bPass,
      bPass
        ? `Refused by Adag: the pledge fell to ${btc(sixty)} since its last check, so it checked, and ${overLimit(bOut)}. The whole batch undid itself.`
        : `Not refused as expected: ${tidy(bOut)}; bill ${b.status}.`,
      `${bOut}; bill ${b.status}`,
      b.r.gas,
    );
  };

  const A3 = async () => {
    const id = firstNewId();
    const extra = ctx.value / 2n - ctx.debt;
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYER, batch([morpho.borrow(ctx.params, extra, 0n), ...cashPay(id)])), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const r = res[1]![0]!;
    const st = statusOf(res[1]![1]!);
    const out = outcome(r);
    const pass = !r.ok && out.startsWith("MemoFailed(LtvAboveLimit(") && st === "Open";
    row(
      "A3",
      pass,
      pass ? `Refused by Adag: borrowing ${usdc(extra)} more is new debt, so it checked, and ${overLimit(out)}.` : `Not refused as expected: ${tidy(out)}; bill ${st}.`,
      `${out}; bill ${st}`,
      r.gas,
    );
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
    const paid = first.ok ? findBillPaid(first.logs, ADAG_BILLS) : null;
    const ltvRead = res[1]![1]!;
    const ltvAfter = ltvRead.ok ? decodeFunctionResult({ abi: adagAbi, functionName: "loanToValue", data: ltvRead.returnData }) : null;
    const second = res[2]![0]!;
    const stB = statusOf(res[2]![1]!);
    const secondOut = outcome(second);
    const firstOk = first.ok && paid?.loanChecked === false;
    const secondOk = !second.ok && secondOut.startsWith("MemoFailed(LtvAboveLimit(") && stB === "Open";
    const pass = firstOk && secondOk;
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
    const r = res[1]![0]!;
    const pass = !r.ok && outcome(r) === "SelfPayment()";
    row("A5", pass, pass ? "Refused. A supplier cannot pay its own bill: no money would change hands, so nothing would prove it was paid." : `Not refused as expected: ${tidy(outcome(r))}.`, outcome(r), r.gas);
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
      const r = res[0]![i]!;
      const pass = !r.ok && outcome(r) === want;
      row(id, pass, pass ? plain : `Not refused as expected: ${tidy(outcome(r))}.`, outcome(r), r.gas);
    });
  };

  const A7 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), overrides: STRANGER_FUNDS, calls: [tx(STRANGER, adag.void(id)), tx(DEMO_PAYEE, adag.void(1n)), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const [stranger, paidVoid, read] = res[1]! as [SimResult, SimResult, SimResult];
    const st = statusOf(read);
    const aPass = !stranger.ok && outcome(stranger) === `NotPayee(${STRANGER})` && st === "Open";
    row("A7a", aPass, aPass ? "Refused. Only the supplier who wrote a bill can cancel it; the bill stays open and payable." : `Not refused as expected: ${tidy(outcome(stranger))}; bill ${st}.`, `${outcome(stranger)}; bill ${st}`, stranger.gas);
    const bPass = !paidVoid.ok && outcome(paidVoid) === "BillNotOpen(1, 2)";
    row("A7b", bPass, bPass ? "Refused. Bill #1 is paid, and a paid bill can never be cancelled." : `Not refused as expected: ${tidy(outcome(paidVoid))}.`, outcome(paidVoid), paidVoid.gas);
  };

  const A8 = async () => {
    const id = firstNewId();
    const res = await sim([newBills(1), { time: t(2), calls: [tx(DEMO_PAYER, batch([payViaMemo(id)])), tx(DEMO_PAYER, adag.bill(id))] }]);
    written(res[0]!);
    const r = res[1]![0]!;
    const st = statusOf(res[1]![1]!);
    const pass = !r.ok && st === "Open";
    row("A8", pass, pass ? "Refused. The USDC token would not move money Adag was never approved to move, so the whole batch undid itself and the bill stays open." : `Not refused as expected: ${tidy(outcome(r))}; bill ${st}.`, `${outcome(r)}; bill ${st}`, r.gas);
  };

  // SIMULATED PRICE DROP: the mock oracle replaces the USDC market's oracle with a price 25% lower, from the
  // second simulated block on. Morpho and Adag both see it.
  const A9 = async () => {
    const id = firstNewId();
    const drop = (ctx.price * 75n) / 100n;
    const mock = { [ctx.params.oracle]: { code: mockOracleCode(drop, ctx.baseFeed, ctx.quoteFeed) } };
    const cash = await sim([newBills(1), { time: t(2), overrides: mock, calls: [tx(DEMO_PAYER, adag.ltv()), tx(DEMO_PAYER, batch(cashPay(id)))] }]);
    written(cash[0]!);
    const ltvRead = cash[1]![0]!;
    const ltvNow = ltvRead.ok ? decodeFunctionResult({ abi: adagAbi, functionName: "loanToValue", data: ltvRead.returnData }) : null;
    const c = cash[1]![1]!;
    const paid = c.ok ? findBillPaid(c.logs, ADAG_BILLS) : null;
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
  ];
  for (const [attack, ids] of attacks) {
    try {
      await attack();
    } catch (e) {
      // C19: an attack that could not run is never shown as refused.
      const reason = `could not run: ${((e as Error).message || "unknown error").slice(0, 200)}`;
      for (const id of ids) if (!done.has(id)) emit({ type: "result", result: { id, pass: false, verdict: "error", reason, raw: reason, gas: null } });
      ids.forEach((id) => done.add(id));
    }
  }
}
