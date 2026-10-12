// The bill, send and fund-eurc commands of scripts/e2e-fork.sh, spoken straight to the fork's JSON-RPC from Windows.
// Each call through wsl.exe risks wedging WSL under the test load (it did, three times on 9 October 2026), while the fork
// on 127.0.0.1:8545 stays reachable from Windows the whole time. So only start and stop still go through the shell.
//
// Same inputs and outputs as the shell commands: bill returns the new bill id, send returns '"status":"0x1"', and
// fundEurc returns the recipient's EURC balance in base units. A transaction the fork refuses or reverts throws.
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, parseAbiItem, stringToHex, toHex } from 'viem';

const RPC = 'http://127.0.0.1:8545';
const PAYEE = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
// The current AdagBills, and the first deployment, which stays live with its own bills.
const BILLS = { current: '0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB', first: '0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E' };
const CURRENCIES = { USDC: '0x3600000000000000000000000000000000000000', EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' };
const EURC = CURRENCIES.EURC;
const MORPHO = '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD';
// What arc-cast sent for --gas-price 20gwei, read off the fork: a type 2 transaction capped at 20 gwei, which is Arc's
// base fee, with a 1 wei tip.
const FEES = { maxFeePerGas: toHex(20_000_000_000n), maxPriorityFeePerGas: toHex(1n) };
// arc-cast used the bare estimate as the limit, which only held because each WSL round trip took seconds. Called this fast,
// the estimate can run in the same second as Morpho's last update, so it skips the interest accrual that the mined block,
// a second later, pays for: a withdrawCollateral estimated at 63,707 gas ran out and needed 89,468 (9 October 2026).
// Unused gas is refunded, so the doubled limit costs nothing.
const GAS_HEADROOM = 2n;
const RECEIPT_WAIT_MS = 120_000;

const billsAbi = parseAbi(['function createBill(address currency, uint256 amount, uint64 due, bytes ref) returns (uint256)', 'function billCount() view returns (uint256)']);
const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address who) view returns (uint256)']);

// viem's own retries are off: a failed call is tried again below only when the fork lost its network, never blindly.
const client = createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 0 }) });

// The fork fetches Arc's state from the public RPC the first time anything touches it, and WSL's name lookup drops for a few
// seconds now and then. A call that failed only for that reason is tried again; any other failure stops the run. Each step is
// retried on its own, so a transaction the fork never accepted is the only one ever sent twice.
const FORK_NETWORK_HICCUP = /dns error|failed to lookup address|error sending request for url \(https:\/\/rpc\.mainnet\.arc\.io/;
const wordsOf = (error) => [error?.shortMessage, error?.details, error?.message].filter(Boolean).join('\n');
async function steady(command, step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= 4 || !FORK_NETWORK_HICCUP.test(wordsOf(error))) throw error;
      console.log(`  the fork lost its network for a moment (${command}, attempt ${attempt}); trying again`);
      await new Promise((r) => setTimeout(r, 6_000));
    }
  }
}

const request = (command, method, params) => steady(command, () => client.request({ method, params }));

async function transact(command, label, from, to, data) {
  try {
    const tx = { from, to, data };
    const estimate = BigInt(await request(command, 'eth_estimateGas', [tx]));
    const hash = await request(command, 'eth_sendTransaction', [{ ...tx, gas: toHex(estimate * GAS_HEADROOM), ...FEES }]);
    const deadline = Date.now() + RECEIPT_WAIT_MS;
    for (;;) {
      const receipt = await request(command, 'eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(`reverted on the fork in ${hash}`);
        return receipt;
      }
      if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${RECEIPT_WAIT_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (error) {
    throw new Error(`e2e-fork-rpc ${label} failed: ${wordsOf(error)}`, { cause: error });
  }
}

// cast's argument text for one parameter: "(a,b,c)" for a tuple, "[a,b]" for an array, and plain text otherwise.
function splitOuter(text, open, close) {
  const t = text.trim();
  if (!t.startsWith(open) || !t.endsWith(close)) throw new Error(`expected ${open}...${close}, got ${text}`);
  const inner = t.slice(1, -1);
  if (inner.trim() === '') return [];
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

function castArg(param, value) {
  const text = String(value);
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) return splitOuter(text, '[', ']').map((part) => castArg({ ...param, type: array[1] }, part));
  if (param.type === 'tuple') {
    const parts = splitOuter(text, '(', ')');
    if (parts.length !== param.components.length) throw new Error(`a tuple of ${param.components.length} needs as many values, got ${text}`);
    return parts.map((part, i) => castArg(param.components[i], part));
  }
  // cast takes an address in any letter case, so the checksum is not enforced here either.
  if (param.type === 'address') return getAddress(text.toLowerCase());
  if (param.type === 'bool') {
    if (text !== 'true' && text !== 'false') throw new Error(`a bool is true or false, got ${text}`);
    return text === 'true';
  }
  if (/^u?int\d*$/.test(param.type)) return BigInt(text);
  return text;
}

/** bill USDC|EURC <base units> <reference> [current|first]: the demo payee writes a bill due in 7 days; returns its id. */
export async function bill(currencyName, amount, ref, deployment = 'current') {
  const bills = BILLS[deployment];
  if (!bills) throw new Error('current or first');
  const currency = CURRENCIES[currencyName];
  if (!currency) throw new Error('USDC or EURC');
  const label = `bill ${currencyName} ${amount} ${ref} ${deployment}`;
  const now = (await steady('bill', () => client.getBlock({ blockTag: 'latest' }))).timestamp;
  // "hex:0x..." passes the reference bytes as they are; anything else is sent as its UTF-8 bytes.
  const refBytes = ref.startsWith('hex:') ? ref.slice('hex:'.length) : stringToHex(ref);
  let data;
  try {
    data = encodeFunctionData({ abi: billsAbi, functionName: 'createBill', args: [currency, BigInt(amount), now + 7n * 86400n, refBytes] });
  } catch (error) {
    throw new Error(`e2e-fork-rpc ${label} failed: ${wordsOf(error)}`, { cause: error });
  }
  await transact('bill', label, PAYEE, bills, data);
  return steady('bill', () => client.readContract({ address: bills, abi: billsAbi, functionName: 'billCount' }));
}

/** send <from> <to> <signature> [args...]: a transaction from any address, impersonated first; cast's argument text. */
export async function send(from, to, signature, ...args) {
  const label = ['send', from, to, signature, ...args].join(' ');
  let data;
  try {
    const item = parseAbiItem(`function ${signature}`);
    if (item.inputs.length !== args.length) throw new Error(`${signature} takes ${item.inputs.length} values, got ${args.length}`);
    data = encodeFunctionData({ abi: [item], functionName: item.name, args: item.inputs.map((param, i) => castArg(param, args[i])) });
  } catch (error) {
    throw new Error(`e2e-fork-rpc ${label} failed: ${wordsOf(error)}`, { cause: error });
  }
  await request('send', 'anvil_impersonateAccount', [from]);
  const receipt = await transact('send', label, from, to, data);
  return `"status":"${receipt.status}"`;
}

/** fund-eurc <to> <base units>: Morpho sends EURC; returns the recipient's EURC balance after, in base units. */
export async function fundEurc(to, amount) {
  const label = `fund-eurc ${to} ${amount}`;
  // Morpho holds the EURC market's cash, so it is the one EURC holder sure to exist. Its native balance is its USDC on
  // Arc, so it already pays its own gas and must never be overwritten with anvil_setBalance.
  let data;
  try {
    data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(String(to).toLowerCase()), BigInt(amount)] });
  } catch (error) {
    throw new Error(`e2e-fork-rpc ${label} failed: ${wordsOf(error)}`, { cause: error });
  }
  await request('fund-eurc', 'anvil_impersonateAccount', [MORPHO]);
  await transact('fund-eurc', label, MORPHO, EURC, data);
  const balance = await steady('fund-eurc', () => client.readContract({ address: EURC, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(String(to).toLowerCase())] }));
  return balance.toString();
}
