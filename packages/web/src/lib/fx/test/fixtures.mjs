// Shared set-up for the cross-currency tests: a plan shaped like the ones Circle returns (a fee step, then a swap step),
// funding for a 100 USDC bill from a EURC loan, and helpers to write the logs a simulation would show. Not a test file.
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, pad, parseGwei, stringToHex, toHex } from 'viem';

const C = await import('../../pay/constants.ts');
const A = await import('../../pay/abi.ts');
const { encodeExecute } = await import('../plan.ts');
const { amountToSell } = await import('../estimate.ts');
const build = await import('../../pay/build.ts');

export { C, A, build };
export const PAYER = getAddress('0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE');
export const PAYEE = getAddress('0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B');
export const ATTACKER = getAddress('0x00000000000000000000000000000000000f0002');
export const ZERO = getAddress('0x0000000000000000000000000000000000000000');
export const CHAIN_TIME = 1_800_000_000n;
export const usdc = C.CURRENCIES[0];
export const eurc = C.CURRENCIES[1];
export const MAX_FEE = parseGwei('41');
export const SIGNATURE = `0x${'11'.repeat(65)}`;
export const RATE = { answer: 112_703_000n, decimals: 8, updatedAt: CHAIN_TIME - 3_600n };
export const TOTAL = 100_000_000n;
export const OWN_USDC = 500_000_000n;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const FEE_TARGET = '0xf992EFCB5FA2eD7cB48310D9dd8Cb4ce5FB7DdC9';
const DIAMOND = '0xA4072583658Fae592A3506A42431cb6316a8d40b';
let counter = 0n;

// Circle's plan for selling amountIn of tokenIn for at least minOut of tokenOut, to this account.
export function planParams({ tokenIn, tokenOut, amountIn, minOut, account = PAYER, deadline = CHAIN_TIME + 600n } = {}) {
  counter += 1n;
  return {
    instructions: [
      { target: FEE_TARGET, data: '0x7ebc46f0', value: 0n, tokenIn, amountToApprove: 17_860n, tokenOut: ZERO, minTokenOut: 0n },
      { target: DIAMOND, data: `0x4666fc80${'ab'.repeat(200)}`, value: 0n, tokenIn, amountToApprove: amountIn > 17_860n ? amountIn - 17_860n : amountIn, tokenOut, minTokenOut: minOut + 6_260n },
    ],
    tokens: [{ token: tokenIn, beneficiary: account }, { token: tokenOut, beneficiary: account }],
    execId: 0x01a1117d00000000000000000000n + counter,
    deadline,
    metadata: '0x',
  };
}

// What a plan's calldata is when an encoder other than the app's has written it, so a test can change one field.
export function rawExecute(params, inputs, signature = SIGNATURE) {
  return encodeFunctionData({ abi: A.circleAdapterAbi, functionName: 'execute', args: [params, inputs, signature] });
}
export const oneInput = (token, amount) => [{ permitType: 0, token, amount, permitCalldata: '0x' }];

export const bill = ({ id = 7n, amount = TOTAL, currency = C.USDC, payee = PAYEE, contract = C.ADAG_BILLS } = {}) => ({
  contract, id, payee, status: C.BILL_STATUS.Open, due: CHAIN_TIME + 86_400n, currency, createdAt: CHAIN_TIME - 10n, amount, payer: ZERO, paidAt: 0n, ref: stringToHex('ADAG-FX'),
});

// Funding for a USDC bill paid from a EURC loan (the direction FX-1 proved), with every field a test may want to change.
export function convertFunding(over = {}) {
  const total = over.total ?? TOTAL;
  const amountIn = over.amountIn ?? amountToSell(total, 'USDC', RATE, 40n);
  const { total: _t, deadline: _d, ...rest } = over;
  const plan = over.plan ?? encodeExecute(planParams({ tokenIn: C.EURC, tokenOut: C.USDC, amountIn, minOut: total, deadline: over.deadline }), C.EURC, amountIn, SIGNATURE);
  return {
    from: 'convert', loan: 'EURC', amountIn, pledge: 3_048_120n, marketParams: eurc.params, plan,
    outputBalance: OWN_USDC, maxFeePerGas: MAX_FEE, chainTime: CHAIN_TIME, rate: RATE, ...rest,
  };
}

export const builtBill = (over) => build.buildPayConverted(bill(), PAYER, convertFunding(over));

// A EURC bill paid from a USDC loan: the reverse direction.
export function reverseFunding(over = {}) {
  const total = over.total ?? 3_000_000n;
  const amountIn = over.amountIn ?? amountToSell(total, 'EURC', RATE, 150n);
  const params = planParams({ tokenIn: C.USDC, tokenOut: C.EURC, amountIn, minOut: total });
  const { total: _t, ...rest } = over;
  return {
    from: 'convert', loan: 'USDC', amountIn, pledge: 104_020n, marketParams: usdc.params, plan: encodeExecute(params, C.USDC, amountIn, SIGNATURE),
    outputBalance: 0n, maxFeePerGas: MAX_FEE, chainTime: CHAIN_TIME, rate: RATE, ...rest,
  };
}

// A close of a EURC loan with USDC.
export function closeFunding(over = {}) {
  const approval = over.approval ?? 100_100_003n;
  const amountIn = over.amountIn ?? amountToSell(approval, 'EURC', RATE, 40n);
  const params = planParams({ tokenIn: C.USDC, tokenOut: C.EURC, amountIn, minOut: approval });
  const { approval: _a, ...rest } = over;
  return { amountIn, plan: encodeExecute(params, C.USDC, amountIn, SIGNATURE), outputBalance: 0n, maxFeePerGas: MAX_FEE, chainTime: CHAIN_TIME, rate: RATE, ...rest };
}
export const POSITION = { shares: 99_376_725_563_281n, collateral: 342_164n };
export const builtClose = (over, guardStop) => build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, over?.approval ?? 100_100_003n, eurc.params, closeFunding(over), guardStop);

// Calls, as the builder writes them, and the pieces a test swaps out.
export const call3 = (target, callData) => ({ target, allowFailure: false, callData });
export const approveCall = (token, spender, amount) => call3(token, encodeFunctionData({ abi: A.erc20Abi, functionName: 'approve', args: [spender, amount] }));
export const transferCall = (token, to, amount) => call3(token, encodeFunctionData({ abi: A.erc20Abi, functionName: 'transfer', args: [to, amount] }));
export const replaceAt = (calls, i, next) => calls.map((c, j) => (j === i ? next : c));
export const without = (calls, i) => calls.filter((_, j) => j !== i);
export const moveBefore = (calls, from, to) => {
  const out = calls.filter((_, j) => j !== from);
  out.splice(to, 0, calls[from]);
  return out;
};
// The position of each step in a converted USDC bill batch built by builtBill().
export const AT = { approveBtc: 0, supply: 1, borrow: 2, approveAdapter: 3, execute: 4, floor: 5, approveBill: 6, pay: 7, reset: 8 };

// Logs, shaped as the node returns them.
const word = (address) => pad(address, { size: 32 });
export const transferLog = (token, from, to, amount) => ({ address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: pad(toHex(amount), { size: 32 }) });
export const nativeLog = (from, to, value, emitter = '0xfffffffffffffffffffffffffffffffffffffffe') => transferLog(emitter, from, to, value);
export function billPaidLog({ contract = C.ADAG_BILLS, id = 7n, payer = PAYER, payee = PAYEE, currency = C.USDC, amount = TOTAL } = {}) {
  const topics = encodeEventTopics({ abi: A.adagAbi, eventName: 'BillPaid', args: { id, payer, payee } });
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currency, amount, true]);
  return { address: contract, topics, data, blockNumber: 1n, transactionHash: `0x${'22'.repeat(32)}`, logIndex: 3, removed: false };
}

// The logs a successful run of builtBill() leaves, from the payer's side.
export function honestLogs(conversion) {
  return [
    transferLog(C.CIRBTC, PAYER, C.MORPHO, conversion.pledge),
    transferLog(conversion.tokenIn, PAYER, C.CIRCLE_SWAP_ADAPTER, conversion.amountIn),
    transferLog(conversion.tokenOut, PAYER, PAYER, conversion.floor),
    nativeLog(PAYER, PAYEE, TOTAL * 10n ** 12n),
    transferLog(C.USDC, PAYER, PAYEE, TOTAL),
    billPaidLog(),
  ];
}
