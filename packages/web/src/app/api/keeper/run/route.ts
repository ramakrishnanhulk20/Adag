import { json, sameSecret } from "@/lib/alerts/http";
import { runOnce } from "@/lib/guard/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Above the worst run, about 105 s, so the platform never cuts a run off mid-send (C63, LEASE_MS).
export const maxDuration = 150;

// Vercel's cron sends GET with "Authorization: Bearer <CRON_SECRET>"; the local poller sends the same as POST.
async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "The keeper's run is not configured on this server yet." }, 503);
  if (!sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) return json({ error: "Not allowed." }, 401);
  const outcome = await runOnce("cron");
  return json(outcome.body, outcome.status);
}

export const GET = handle;
export const POST = handle;
