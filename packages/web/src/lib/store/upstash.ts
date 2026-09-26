// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import type { Address } from "viem";
import { normaliseAddress, type StoreKey } from "./keys";

// Upstash's REST API: POST the command as a JSON array, get {"result": ...} or {"error": "..."} back.
export type Store = {
  get(key: StoreKey): Promise<string | null>;
  // True only when the value was written. With nx, false means someone already holds the key.
  set(key: StoreKey, value: string, options?: { nx?: boolean; px?: number }): Promise<boolean>;
  // Read and delete in one step, so a code or a pending link can be used once and only once.
  getdel(key: StoreKey): Promise<string | null>;
  del(key: StoreKey): Promise<void>;
  // Adds and sets the key to expire, returning the new total. The expiry is set on every call, so a counter always dies.
  incrby(key: StoreKey, amount: number, ttlSeconds: number): Promise<number>;
  sadd(key: StoreKey, member: Address): Promise<void>;
  srem(key: StoreKey, member: Address): Promise<void>;
  scard(key: StoreKey): Promise<number>;
  smembers(key: StoreKey): Promise<string[]>;
  // Deletes the key only while it still holds this value, so a run never frees a lease another run has taken since.
  delIfEquals(key: StoreKey, value: string): Promise<boolean>;
};

export class StoreError extends Error {}

const MAX_RESPONSE_CHARS = 1_000_000;
const DEL_IF_EQUALS = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

// namespace goes in front of every key, so a test run against the real store writes only under "test:".
type Options = { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch; namespace?: string };

export function createStore({ url, token, timeoutMs = 3_000, fetchImpl = fetch, namespace = "" }: Options): Store {
  const base = url.replace(/\/+$/, "");
  const ns = (key: StoreKey) => `${namespace}${key}`;

  async function command(args: (string | number)[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(base, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch {
      throw new StoreError("The store did not answer in time.");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new StoreError("The store sent more than expected.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StoreError(`The store answered ${response.status} with something that is not JSON.`);
    }
    if (typeof body !== "object" || body === null) throw new StoreError("The store sent an unexpected answer.");
    if ("error" in body) throw new StoreError("The store refused a command.");
    if (!response.ok || !("result" in body)) throw new StoreError(`The store answered ${response.status}.`);
    return (body as { result: unknown }).result;
  }

  const text = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== "string") throw new StoreError("The store sent an unexpected value.");
    return value;
  };
  const count = (value: unknown): number => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isSafeInteger(n)) throw new StoreError("The store sent an unexpected number.");
    return n;
  };

  return {
    get: async (key) => text(await command(["GET", ns(key)])),
    set: async (key, value, options = {}) => {
      const args: (string | number)[] = ["SET", ns(key), value];
      if (options.px !== undefined) args.push("PX", Math.max(1, Math.trunc(options.px)));
      if (options.nx) args.push("NX");
      return (await command(args)) === "OK";
    },
    getdel: async (key) => text(await command(["GETDEL", ns(key)])),
    del: async (key) => {
      await command(["DEL", ns(key)]);
    },
    incrby: async (key, amount, ttlSeconds) => {
      const total = count(await command(["INCRBY", ns(key), Math.trunc(amount)]));
      await command(["EXPIRE", ns(key), Math.max(1, Math.trunc(ttlSeconds))]);
      return total;
    },
    sadd: async (key, member) => {
      await command(["SADD", ns(key), normaliseAddress(member)]);
    },
    srem: async (key, member) => {
      await command(["SREM", ns(key), normaliseAddress(member)]);
    },
    scard: async (key) => count(await command(["SCARD", ns(key)])),
    smembers: async (key) => {
      const result = await command(["SMEMBERS", ns(key)]);
      if (!Array.isArray(result) || !result.every((m) => typeof m === "string")) throw new StoreError("The store sent an unexpected list.");
      return result as string[];
    },
    delIfEquals: async (key, value) => count(await command(["EVAL", DEL_IF_EQUALS, 1, ns(key), value])) === 1,
  };
}
