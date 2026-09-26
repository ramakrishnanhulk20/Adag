import { decodeFunctionResult, encodeFunctionData, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { MARKET_EURC, MARKET_USDC, MORPHO, USDC, USDC_MARKET_ORACLE } from "@/lib/arc/constants";
import { guardAbi } from "@/lib/guard/abi";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { OTHER_USDC_CIRBTC_MARKET } from "@/lib/pay/constants";
import { erc20Abi, morphoAbi, oracleAbi } from "./abi";
import { PREMISE_LINE, type CheckId } from "./catalogue";
import { DEMO_PAYEE, DEMO_PAYER, GUARD_STRANGER, NO_LOAN_WALLET } from "./constants";
import { runEach } from "./bills";
import {
  approve,
  debtDown,
  debtUp,
  loanPremise,
  LOOK_ALIKE,
  ltvOf,
  mockOracleCode,
  outcome,
  pct,
  tx,
  usdc,
  usdPrice,
  verifyUsdcParams,
  type Params,
  type Pin,
  type Row,
  type Step,
} from "./kit";
import { simulate, type SimBlock, type SimResult } from "./simulate";

// A TypeScript port of packages/contracts/prove-it/guard-attack.mjs, G1 to G10, against the live AdagGuard.
// The live demo loan sits at 30%, under the 35% trigger, since the guard's own live repayment on 26 September. So,
// as guard-attack.mjs now does, every simulation starts with one premise block in which the payer borrows on Morpho
// (or repays) until the loan sits at 38.00%. That is an ordinary transaction of the payer's own, simulated; no
// storage of AdagGuard, Morpho or the oracle is overridden. The price-crash rows alone swap in a mock oracle.

const PREMISE_LTV = 380000000000000000n;
const TRIGGER = 350000000000000000n;
const TARGET = 300000000000000000n;
const MU = MARKET_USDC;
const STRANGER_FUNDS = { [GUARD_STRANGER]: { balance: toHex(100n * 10n ** 18n) } };

export const GUARD_IDS: CheckId[] = ["G6", "G1", "G2a", "G2b", "G2c", "G3", "G4", "G5a", "G5b", "G7", "G8", "G9a", "G9b", "G10"];

const g = (from: Address, fn: string, args: readonly unknown[] = []) => ({
  from,
  to: ADAG_GUARD as Address,
  data: encodeFunctionData({ abi: guardAbi, functionName: fn as never, args: args as never }),
});
const read = (to: Address, abi: typeof erc20Abi | typeof morphoAbi | typeof oracleAbi, fn: string, args: readonly unknown[] = []) => ({
  from: GUARD_STRANGER,
  to,
  data: encodeFunctionData({ abi, functionName: fn as never, args: args as never }) as Hex,
});

export async function runGuard(pin: Pin, row: Row, state: (lines: string[]) => void): Promise<void> {
  if (!ADAG_GUARD) throw new Error("AdagGuard is not deployed on this build.");
  const guard = ADAG_GUARD;

  const bal = (who: Address) => read(USDC, erc20Abi, "balanceOf", [who]);
  const allowance = (owner: Address, spender: Address) => read(USDC, erc20Abi, "allowance", [owner, spender]);
  const pos = (who: Address) => read(MORPHO, morphoAbi, "position", [MU, who]);
  const mkt = () => read(MORPHO, morphoAbi, "market", [MU]);
  const rule = (trigger: bigint, target: bigint, expiry = 0n) => g(DEMO_PAYER, "setRule", [MU, trigger, target, expiry]);
  const approveGuard = (amount: bigint) => tx(DEMO_PAYER, approve(USDC, guard, amount));
  const protect = (who: Address = DEMO_PAYER, market: Hex = MU) => g(GUARD_STRANGER, "protect", [who, market]);
  const quote = (who: Address = DEMO_PAYER, market: Hex = MU) => g(GUARD_STRANGER, "quote", [who, market]);
  const num = (r: SimResult) => {
    if (!r.ok) throw new Error(`a balance read failed: ${outcome(r)}`);
    return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.returnData });
  };
  const repaidOf = (r: SimResult) => (r.ok ? decodeFunctionResult({ abi: guardAbi, functionName: "protect", data: r.returnData }) : null);
  const quoteOf = (r: SimResult) => {
    if (!r.ok) throw new Error(`quote failed: ${outcome(r)}`);
    return decodeFunctionResult({ abi: guardAbi, functionName: "quote", data: r.returnData });
  };
  const ruleOf = (r: SimResult) => {
    if (!r.ok) throw new Error(`ruleOf failed: ${outcome(r)}`);
    return decodeFunctionResult({ abi: guardAbi, functionName: "ruleOf", data: r.returnData });
  };
  const decodePos = (r: SimResult) => decodeFunctionResult({ abi: morphoAbi, functionName: "position", data: r.returnData });
  const decodeMkt = (r: SimResult) => decodeFunctionResult({ abi: morphoAbi, functionName: "market", data: r.returnData });
  const emitted = (r: SimResult) => r.logs.some((l) => l.address.toLowerCase() === guard.toLowerCase());

  // The live state, read once with no premise.
  const base = await simulate(
    [
      {
        time: pin.timestamp + 1n,
        calls: [
          read(MORPHO, morphoAbi, "idToMarketParams", [MU]),
          pos(DEMO_PAYER),
          mkt(),
          read(USDC_MARKET_ORACLE, oracleAbi, "price"),
          read(USDC_MARKET_ORACLE, oracleAbi, "BASE_FEED_1"),
          read(USDC_MARKET_ORACLE, oracleAbi, "QUOTE_FEED_1"),
          bal(DEMO_PAYER),
          g(GUARD_STRANGER, "ruleOf", [DEMO_PAYER, MU]),
          allowance(DEMO_PAYER, guard),
        ],
      },
    ],
    pin.number,
  );
  const bad = base[0]!.findIndex((r) => !r.ok);
  if (bad >= 0) throw new Error(`guard baseline read ${bad + 1} failed: ${outcome(base[0]![bad]!)}`);
  const p = decodeFunctionResult({ abi: morphoAbi, functionName: "idToMarketParams", data: base[0]![0]!.returnData });
  const params: Params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  verifyUsdcParams(params);
  const livePos = decodePos(base[0]![1]!);
  const liveMkt = decodeMkt(base[0]![2]!);
  const price = decodeFunctionResult({ abi: oracleAbi, functionName: "price", data: base[0]![3]!.returnData });
  const baseFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "BASE_FEED_1", data: base[0]![4]!.returnData });
  const quoteFeed = decodeFunctionResult({ abi: oracleAbi, functionName: "QUOTE_FEED_1", data: base[0]![5]!.returnData });
  const liveUsdc = num(base[0]![6]!);
  const liveRule = ruleOf(base[0]![7]!);
  const liveApproval = num(base[0]![8]!);
  const liveShares = BigInt(livePos[1]);
  const collateral = BigInt(livePos[2]);
  const liveDebt = debtUp(liveShares, BigInt(liveMkt[2]), BigInt(liveMkt[3]));
  if (liveShares === 0n) throw new Error("The payer has no USDC-market loan, so these attacks have nothing to aim at.");
  if (liveUsdc < 1_000000n) throw new Error(`The payer holds ${usdc(liveUsdc)}; these attacks assume at least 1 USDC.`);

  // The shared premise, as guard-attack.mjs builds it: the payer clears any live guard rule and approval, so every
  // row starts with neither, then borrows or repays on Morpho to put the loan at 38.00% (loanPremise).
  const premiseCalls = [
    ...(liveRule.triggerWad !== 0n ? [g(DEMO_PAYER, "clearRule", [MU])] : []),
    ...(liveApproval !== 0n ? [tx(DEMO_PAYER, approve(USDC, guard, 0n))] : []),
  ];
  const premiseLines: string[] = [];
  if (premiseCalls.length) {
    const what = [
      ...(liveRule.triggerWad !== 0n ? [`clears its live guard rule (${pct(BigInt(liveRule.triggerWad))} / ${pct(BigInt(liveRule.targetWad))})`] : []),
      ...(liveApproval !== 0n ? [`sets its ${usdc(liveApproval)} approval to AdagGuard to 0`] : []),
    ];
    premiseLines.push(`Simulated premise: the payer ${what.join(" and ")}, so every row starts with neither.`);
  }
  const loan = loanPremise({ shares: liveShares, collateral, price, totalAssets: BigInt(liveMkt[2]), totalShares: BigInt(liveMkt[3]), debt: liveDebt }, PREMISE_LTV);
  const range = `taking the loan from ${pct(ltvOf(liveDebt, collateral, price))} to ${pct(PREMISE_LTV)}`;
  if (loan.kind === "borrow") {
    premiseCalls.push(tx(DEMO_PAYER, { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params, loan.amount, 0n, DEMO_PAYER, DEMO_PAYER] }) }));
    premiseLines.push(`Simulated premise: the payer borrows ${usdc(loan.amount)} more on Morpho, ${range}.`);
  } else if (loan.kind === "repay") {
    premiseCalls.push(
      tx(DEMO_PAYER, approve(USDC, MORPHO, loan.amount)),
      tx(DEMO_PAYER, { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params, loan.amount, 0n, DEMO_PAYER, "0x"] }) }),
    );
    premiseLines.push(`Simulated premise: the payer repays ${usdc(loan.amount)} of the loan on Morpho, ${range}.`);
  }
  // The rows assume the wallet holds at least 1 USDC after the premise; only if it would not is it topped up.
  const least = 1_000000n;
  const walletAfter = liveUsdc + (loan.kind === "borrow" ? loan.amount : 0n) - (loan.kind === "repay" ? loan.amount : 0n);
  let funding: SimBlock["overrides"];
  if (walletAfter < least) {
    const start = least + (loan.kind === "repay" ? loan.amount : 0n) - (loan.kind === "borrow" ? loan.amount : 0n);
    funding = { [DEMO_PAYER]: { balance: toHex(start * 10n ** 12n) } };
    premiseLines.push(`Simulated funding: a state override sets the payer's wallet to ${usdc(start)} before the premise, so it holds ${usdc(least)} after it.`);
  }
  const premise: SimBlock = { time: pin.timestamp + 1n, overrides: funding, calls: [...premiseCalls, pos(DEMO_PAYER), mkt(), bal(DEMO_PAYER)] };
  const t = (k: number) => pin.timestamp + 1n + BigInt(k);
  const run = async (blocks: SimBlock[]) => {
    const res = await simulate([premise, ...blocks], pin.number);
    const failed = res[0]!.find((r) => !r.ok);
    if (failed) throw new Error(`the premise block failed: ${outcome(failed)}`);
    return { premise: res[0]!, rest: res.slice(1) };
  };

  // A dry pass of the premise alone, so the state line and the labels quote the loan the rows actually meet.
  const dry = await run([]);
  const pPos = decodePos(dry.premise[premiseCalls.length]!);
  const pMkt = decodeMkt(dry.premise[premiseCalls.length + 1]!);
  const pUsdc = num(dry.premise[premiseCalls.length + 2]!);
  const pDebt = debtUp(BigInt(pPos[1]), BigInt(pMkt[2]), BigInt(pMkt[3]));
  const pLtv = ltvOf(pDebt, collateral, price);
  if (pct(pLtv) !== pct(PREMISE_LTV)) throw new Error(`The simulated premise left the loan at ${pct(pLtv)}, not ${pct(PREMISE_LTV)}.`);
  if (pUsdc < least) throw new Error(`The payer holds ${usdc(pUsdc)} after the premise; these attacks assume at least 1 USDC.`);
  let need = 0n;

  state([
    `AdagGuard ${guard}. On chain: the payer's loan ${usdc(liveDebt)} (${pct(ltvOf(liveDebt, collateral, price))}), its rule ${liveRule.triggerWad === 0n ? "none" : `${pct(BigInt(liveRule.triggerWad))} / ${pct(BigInt(liveRule.targetWad))}`}, its approval to AdagGuard ${usdc(liveApproval)}.`,
    ...premiseLines,
    `${PREMISE_LINE} In this run every row starts from a loan of ${usdc(pDebt)} at ${pct(pLtv)}, a wallet of ${usdc(pUsdc)}, no guard rule and no approval; unless a row says otherwise its rule acts at 35% and brings the loan back to 30%. Bitcoin at ${usdPrice(price)} USDC. Simulated stranger ${GUARD_STRANGER}.`,
  ]);

  // G6 runs first because it measures what the loan needs with a full approval, which other rows quote.
  const G6 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approveGuard(1_000000n), quote()] },
      { time: t(2), calls: [protect(), protect(), bal(DEMO_PAYER)] },
      { time: t(3), calls: [protect(), bal(DEMO_PAYER)] },
    ]);
    if (!rest[0]![0]!.ok || !rest[0]![1]!.ok) throw new Error(`setup (rule and approval) failed: ${outcome(rest[0]!.find((r) => !r.ok)!)}`);
    need = quoteOf(rest[0]![2]!)[1];
    const a = repaidOf(rest[1]![0]!);
    const b = repaidOf(rest[1]![1]!);
    const c = repaidOf(rest[2]![0]!);
    const pass = a === need && a > 0n && b === 0n && c === 0n && num(rest[1]![2]!) === num(rest[2]![1]!);
    const shown = [a, b, c].map((x) => (x === null ? "reverted" : usdc(x))).join(", then ");
    row(
      "G6",
      pass,
      pass ? `Held. The first protect repaid ${usdc(a!)}, exactly what brings the loan back to 30%; the two repeats found nothing to do and moved nothing.` : `Did not behave as documented: repaid ${shown}.`,
      `repaid ${shown}`,
      rest[1]![0]!.gas,
    );
  };

  const G1 = async () => {
    const cap = 100_000n;
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approveGuard(cap), bal(DEMO_PAYER)] },
      { time: t(2), calls: [quote(), protect(), bal(DEMO_PAYER), allowance(DEMO_PAYER, guard), bal(guard)] },
      { time: t(3), calls: [protect(), bal(DEMO_PAYER)] },
    ]);
    if (!rest[0]![0]!.ok || !rest[0]![1]!.ok) throw new Error("setup (rule and a 0.1 USDC approval) failed");
    const quoted = quoteOf(rest[1]![0]!)[1];
    const first = repaidOf(rest[1]![1]!);
    const pulled = num(rest[0]![2]!) - num(rest[1]![2]!);
    const left = num(rest[1]![3]!);
    const second = repaidOf(rest[2]![0]!);
    const guardHolds = num(rest[1]![4]!);
    const pass = need > cap && quoted === cap && first === cap && pulled === cap && left === 0n && second === 0n && num(rest[2]![1]!) === num(rest[1]![2]!) && guardHolds === 0n;
    row(
      "G1",
      pass,
      pass
        ? `Held. The loan needed ${usdc(need)}, but the payer approved only ${usdc(cap)}: protect repaid exactly that, the approval fell to zero, and the second protect repaid nothing.`
        : `Did not behave as documented: first ${first === null ? outcome(rest[1]![1]!) : `repaid ${usdc(first)}`}, pulled ${usdc(pulled)}, approval left ${usdc(left)}.`,
      `first protect ${first === null ? outcome(rest[1]![1]!) : `repaid ${usdc(first)}`}, pulled ${usdc(pulled)}, approval left ${usdc(left)}; second protect ${second === null ? outcome(rest[2]![0]!) : `repaid ${usdc(second)}`}; guard holds ${usdc(guardHolds)}`,
      rest[1]![1]!.gas,
    );
  };

  const G2 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approveGuard(1_000000n)] },
      {
        time: t(2),
        calls: [protect(DEMO_PAYER, OTHER_USDC_CIRBTC_MARKET), g(DEMO_PAYER, "setRule", [LOOK_ALIKE, TRIGGER, TARGET, 0n]), protect(DEMO_PAYER, LOOK_ALIKE), bal(DEMO_PAYER), protect(DEMO_PAYER, MARKET_EURC), bal(DEMO_PAYER)],
      },
    ]);
    if (!rest[0]!.every((r) => r.ok)) throw new Error("setup (rule and approval) failed");
    const [other, setLook, protLook, balBefore, eurc, balAfter] = rest[1]! as SimResult[];
    const aPass = !other!.ok && outcome(other!) === `BadMarket(${OTHER_USDC_CIRBTC_MARKET})`;
    row("G2a", aPass, aPass ? "Refused. The other real USDC/cirBTC market is not one of AdagGuard's two fixed markets." : `Not refused as expected: ${outcome(other!)}.`, outcome(other!), other!.gas);
    const bPass = !setLook!.ok && outcome(setLook!) === `BadMarket(${LOOK_ALIKE})` && !protLook!.ok && outcome(protLook!) === `BadMarket(${LOOK_ALIKE})`;
    row(
      "G2b",
      bPass,
      bPass ? "Refused twice. A market id one hex digit away is a different id: setRule and protect both reject it." : `Not refused as expected: setRule ${outcome(setLook!)}; protect ${outcome(protLook!)}.`,
      `setRule: ${outcome(setLook!)}; protect: ${outcome(protLook!)}`,
      protLook!.gas,
    );
    const eurcRepaid = repaidOf(eurc!);
    const moved = num(balBefore!) - num(balAfter!);
    const cPass = eurcRepaid === 0n && moved === 0n;
    row(
      "G2c",
      cPass,
      cPass ? "Held. In the EURC market the payer has no loan and no rule, so protect repaid nothing and no USDC moved." : `Did not behave as documented: ${eurcRepaid === null ? outcome(eurc!) : `repaid ${usdc(eurcRepaid)}`}; payer USDC moved ${usdc(moved)}.`,
      `${eurcRepaid === null ? outcome(eurc!) : `repaid ${usdc(eurcRepaid)}`}; payer USDC moved ${usdc(moved)}`,
      eurc!.gas,
    );
  };

  const G3 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(500000000000000000n, 400000000000000000n), approveGuard(1_000000n), bal(DEMO_PAYER)] },
      { time: t(2), calls: [quote(), protect(), bal(DEMO_PAYER)] },
    ]);
    if (!rest[0]![0]!.ok || !rest[0]![1]!.ok) throw new Error("setup (a 50% / 40% rule) failed");
    const [wouldAct, amount, ltv] = quoteOf(rest[1]![0]!);
    const repaid = repaidOf(rest[1]![1]!);
    const event = emitted(rest[1]![1]!);
    const pass = !wouldAct && amount === 0n && repaid === 0n && !event && num(rest[0]![2]!) === num(rest[1]![2]!);
    row(
      "G3",
      pass,
      pass ? `Held. The loan at ${pct(ltv)} is under the payer's 50% trigger, so protect repaid nothing, emitted nothing and moved nothing.` : `Did not behave as documented: quote ${wouldAct} (${usdc(amount)}); protect ${repaid === null ? outcome(rest[1]![1]!) : `repaid ${usdc(repaid)}`}.`,
      `quote would act ${wouldAct} (${usdc(amount)}) at ${pct(ltv)}; protect ${repaid === null ? outcome(rest[1]![1]!) : `repaid ${usdc(repaid)}`}, event ${event ? "emitted" : "none"}`,
      rest[1]![1]!.gas,
    );
  };

  const G4 = async () => {
    const expiry = t(1) + 60n;
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET, expiry), approveGuard(1_000000n), quote(), bal(DEMO_PAYER)] },
      { time: expiry, calls: [quote(), protect(), bal(DEMO_PAYER)] },
    ]);
    if (!rest[0]![0]!.ok || !rest[0]![1]!.ok) throw new Error("setup (a rule that expires in 60 seconds) failed");
    const early = quoteOf(rest[0]![2]!);
    const late = quoteOf(rest[1]![0]!);
    const repaid = repaidOf(rest[1]![1]!);
    const pass = early[0] === true && late[0] === false && repaid === 0n && num(rest[0]![3]!) === num(rest[1]![2]!);
    row(
      "G4",
      pass,
      pass ? `Held. Before expiry the rule would have repaid ${usdc(early[1])}; at the expiry second it is inert, and protect repaid nothing.` : `Did not behave as documented: before expiry ${early[0]}; at expiry ${late[0]}; protect ${repaid === null ? outcome(rest[1]![1]!) : usdc(repaid)}.`,
      `before expiry quote would act ${early[0]} (${usdc(early[1])}); at expiry quote would act ${late[0]}, protect ${repaid === null ? outcome(rest[1]![1]!) : `repaid ${usdc(repaid)}`}`,
      rest[1]![1]!.gas,
    );
  };

  const G5 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET)] },
      {
        time: t(2),
        calls: [
          g(GUARD_STRANGER, "clearRule", [MU]),
          g(GUARD_STRANGER, "setRule", [MU, 800000000000000000n, 10000000000000000n, 0n]),
          g(GUARD_STRANGER, "ruleOf", [DEMO_PAYER, MU]),
          g(GUARD_STRANGER, "ruleOf", [GUARD_STRANGER, MU]),
        ],
      },
    ]);
    if (!rest[0]![0]!.ok) throw new Error("setup (payer rule) failed");
    const [clear, set, payerRule, strangerRule] = rest[1]! as SimResult[];
    const pr = ruleOf(payerRule!);
    const sr = ruleOf(strangerRule!);
    const intact = BigInt(pr.triggerWad) === TRIGGER && BigInt(pr.targetWad) === TARGET && BigInt(pr.expiry) === 0n;
    const payerText = `${pct(BigInt(pr.triggerWad))} / ${pct(BigInt(pr.targetWad))}`;
    const aPass = !clear!.ok && outcome(clear!) === `NoRule(${GUARD_STRANGER}, ${MU})` && intact;
    row(
      "G5a",
      aPass,
      aPass ? `Refused. clearRule only ever names the sender, and the stranger has no rule; the payer's rule is still ${payerText}.` : `Not refused as expected: ${outcome(clear!)}; payer's rule ${payerText}.`,
      `${outcome(clear!)}; payer's rule still ${payerText}`,
      clear!.gas,
    );
    const bPass = set!.ok && intact && BigInt(sr.triggerWad) === 800000000000000000n && BigInt(sr.targetWad) === 10000000000000000n;
    row(
      "G5b",
      bPass,
      bPass ? `Held. The stranger's setRule went through and wrote only the stranger's own rule (80% / 1%); the payer's is still ${payerText}.` : `Did not behave as documented: ${outcome(set!)}; payer's rule ${payerText}.`,
      `${outcome(set!)}; payer's rule still ${payerText}; the stranger's own rule is ${pct(BigInt(sr.triggerWad))} / ${pct(BigInt(sr.targetWad))}`,
      set!.gas,
    );
  };

  const G7 = async () => {
    const keep = 50_000n;
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approveGuard(1_000000n)] },
      { time: t(2), calls: [tx(DEMO_PAYER, { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEMO_PAYEE, pUsdc - keep] }) }), bal(DEMO_PAYER)] },
      { time: t(3), calls: [protect(), bal(DEMO_PAYER), bal(guard)] },
    ]);
    if (!rest[0]!.every((r) => r.ok) || !rest[1]![0]!.ok) throw new Error("setup (rule, approval, and moving most of the payer's USDC away) failed");
    const held = num(rest[1]![1]!);
    const repaid = repaidOf(rest[2]![0]!);
    const after = num(rest[2]![1]!);
    const guardHolds = num(rest[2]![2]!);
    const pass = held === keep && need > keep && repaid === keep && after === 0n && guardHolds === 0n;
    row(
      "G7",
      pass,
      pass ? `Held. The loan needed ${usdc(need)} but the wallet held ${usdc(held)}: protect repaid exactly that, did not revert, and AdagGuard kept nothing.` : `Did not behave as documented: ${repaid === null ? outcome(rest[2]![0]!) : `repaid ${usdc(repaid)}`}; wallet now ${usdc(after)}.`,
      `${repaid === null ? outcome(rest[2]![0]!) : `repaid ${usdc(repaid)}`}; wallet now ${usdc(after)}; guard holds ${usdc(guardHolds)}`,
      rest[2]![0]!.gas,
    );
  };

  const crash = () => ({ [USDC_MARKET_ORACLE]: { code: mockOracleCode(0n, baseFeed, quoteFeed) } });

  // SIMULATED PRICE CRASH TO ZERO: the mock oracle sits at the market oracle's address from the crash block on.
  const G8 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approveGuard(2_000000n)] },
      {
        time: t(2),
        overrides: crash(),
        calls: [
          { from: GUARD_STRANGER, to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [params] }) },
          pos(DEMO_PAYER),
          mkt(),
          quote(),
          protect(),
          pos(DEMO_PAYER),
          mkt(),
          bal(guard),
        ],
      },
    ]);
    if (!rest[0]!.every((r) => r.ok)) throw new Error("setup (rule and a 2 USDC approval) failed");
    if (!rest[1]![0]!.ok) throw new Error(`accrueInterest failed: ${outcome(rest[1]![0]!)}`);
    const p0 = decodePos(rest[1]![1]!);
    const m0 = decodeMkt(rest[1]![2]!);
    const cap = debtDown(BigInt(p0[1]), BigInt(m0[2]), BigInt(m0[3]));
    const [wouldAct, quoted, ltv] = quoteOf(rest[1]![3]!);
    const repaid = repaidOf(rest[1]![4]!);
    const left = rest[1]![5]!.ok && rest[1]![6]!.ok ? debtUp(BigInt(decodePos(rest[1]![5]!)[1]), BigInt(decodeMkt(rest[1]![6]!)[2]), BigInt(decodeMkt(rest[1]![6]!)[3])) : null;
    const guardHolds = num(rest[1]![7]!);
    const pass = wouldAct && quoted === cap && repaid === cap && left !== null && left <= 1n && guardHolds === 0n;
    row(
      "G8",
      pass,
      pass
        ? `Held. At a zero price protect repaid ${usdc(repaid!)}, the debt rounded down, so Morpho's share maths could not underflow; ${usdc(left!)} of debt is left and AdagGuard kept nothing.`
        : `Did not behave as documented: quote ${wouldAct} ${usdc(quoted)}; protect ${repaid === null ? outcome(rest[1]![4]!) : usdc(repaid)} against ${usdc(cap)}.`,
      `quote ${wouldAct} at ${pct(ltv)}, ${usdc(quoted)}; protect ${repaid === null ? outcome(rest[1]![4]!) : `repaid ${usdc(repaid)}`} against a rounded-down debt of ${usdc(cap)}; debt left ${left === null ? "?" : usdc(left)}; guard holds ${usdc(guardHolds)}`,
      rest[1]![4]!.gas,
    );
  };

  // The premise already cleared the payer's live rule, so G9a meets a payer with an approval and no rule.
  const G9 = async () => {
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: [approveGuard(1_000000n), bal(DEMO_PAYER)] },
      { time: t(2), overrides: crash(), calls: [quote(), protect(), bal(DEMO_PAYER), protect(NO_LOAN_WALLET), quote(NO_LOAN_WALLET)] },
    ]);
    if (!rest[0]![0]!.ok) throw new Error("setup (a 1 USDC approval, no rule) failed");
    const before = num(rest[0]![1]!);
    const [wouldAct, amount, ltv] = quoteOf(rest[1]![0]!);
    const repaid = repaidOf(rest[1]![1]!);
    const moved = before - num(rest[1]![2]!);
    const aPass = !wouldAct && amount === 0n && repaid === 0n && moved === 0n;
    row(
      "G9a",
      aPass,
      aPass
        ? "Held. Even at a zero price, a payer with an approval but no rule is left alone: protect repaid nothing and no USDC moved."
        : `Did not behave as documented: quote ${wouldAct} (${usdc(amount)}); protect ${repaid === null ? outcome(rest[1]![1]!) : usdc(repaid)}; USDC moved ${usdc(moved)}.`,
      `quote would act ${wouldAct} at ${pct(ltv)} (${usdc(amount)}); protect ${repaid === null ? outcome(rest[1]![1]!) : `repaid ${usdc(repaid)}`}; payer USDC moved ${usdc(moved)}`,
      rest[1]![1]!.gas,
    );
    const none = repaidOf(rest[1]![3]!);
    const q = quoteOf(rest[1]![4]!);
    const bPass = none === 0n && !q[0];
    row(
      "G9b",
      bPass,
      bPass ? `Held. A wallet with no loan and no rule (${NO_LOAN_WALLET}) has nothing to repay; nothing moved.` : `Did not behave as documented: ${none === null ? outcome(rest[1]![3]!) : `repaid ${usdc(none)}`}; quote ${q[0]}.`,
      `${none === null ? outcome(rest[1]![3]!) : `repaid ${usdc(none)}`}; quote would act ${q[0]}`,
      rest[1]![3]!.gas,
    );
  };

  // C39: no privileged role. The interface's state-changing functions are exactly the three a borrower and a keeper
  // need, and the admin calls a drain would use do not exist in the deployed code at all.
  const G10 = async () => {
    const writes = guardAbi
      .filter((e) => e.type === "function" && !["view", "pure"].includes(e.stateMutability as string))
      .map((e) => (e as { name: string }).name)
      .sort();
    const tries = ["transferOwnership(address)", "withdraw(address,uint256)", "rescue(address,address,uint256)", "pause()", "upgradeToAndCall(address,bytes)"];
    const { rest } = await run([
      { time: t(1), overrides: STRANGER_FUNDS, calls: tries.map((sig) => ({ from: GUARD_STRANGER, to: guard, data: `${toFunctionSelector(sig)}${"00".repeat(96)}` as Hex })) },
    ]);
    const refused = rest[0]!.every((r) => !r.ok);
    const pass = writes.join(",") === "clearRule,protect,setRule" && refused;
    row(
      "G10",
      pass,
      pass ? "Refused, all five. None of those functions exists on the deployed AdagGuard, so every call reverted; the only state-changing functions are clearRule, protect and setRule." : `Did not behave as documented: ${refused ? "" : "an admin call succeeded; "}writes ${writes.join(", ")}.`,
      `state-changing functions: ${writes.join(", ")}; admin calls: ${refused ? "all reverted" : "SOME SUCCEEDED"}`,
      rest[0]![0]!.gas,
    );
  };

  await runEach(
    [
      [G6, ["G6"]],
      [G1, ["G1"]],
      [G2, ["G2a", "G2b", "G2c"]],
      [G3, ["G3"]],
      [G4, ["G4"]],
      [G5, ["G5a", "G5b"]],
      [G7, ["G7"]],
      [G8, ["G8"]],
      [G9, ["G9a", "G9b"]],
      [G10, ["G10"]],
    ],
    row,
  );
}
