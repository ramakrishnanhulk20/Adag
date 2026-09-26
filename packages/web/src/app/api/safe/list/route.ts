import { isAddress, getAddress } from "viem";
import { InputError, address } from "@/lib/safe/parse";
import { NOT_CONFIGURED, json, safeService, serviceError, withTimeout } from "@/lib/safe/service";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { TOO_MANY, limitRoute } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SAFES = 50;

// The Safes the service lists for an owner. These are hints for a picker only: before anyone signs, the page checks
// the chosen Safe on chain (verifySafe, C52), whatever this list says.
export async function GET(request: Request) {
  const service = safeService();
  if (!service) return json({ error: NOT_CONFIGURED }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await limitRoute(store, request, "safe-list", 20, 300))) return json({ error: TOO_MANY }, 429);
  let owner;
  try {
    owner = address(new URL(request.url).searchParams.get("owner"), "The owner");
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "The request could not be read." }, 400);
  }
  try {
    const answer = await withTimeout(service.getSafesByOwner(owner));
    const safes = (answer.safes ?? [])
      .filter((s): s is string => typeof s === "string" && isAddress(s, { strict: false }))
      .slice(0, MAX_SAFES)
      .map((s) => getAddress(s));
    return json({ safes, hint: true });
  } catch (error) {
    const e = serviceError(error);
    return json({ error: e.message }, e.status);
  }
}
