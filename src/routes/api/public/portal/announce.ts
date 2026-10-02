import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "old250826pulse";
const MASTER = process.env.MASTER_BASE_URL ?? "https://martech.innovexsis.com";
const PATCH_VERSION = process.env.SLAVE_PATCH_VERSION ?? "v74";

function versionNumber(tag: string) {
  const n = Number.parseInt(String(tag).replace(/^v/i, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export const Route = createFileRoute("/api/public/portal/announce")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request) {
  const origin = new URL(request.url).origin;
  const card = {
    portal_key: PRODUCT,
    role: "slave" as const,
    patch_version: PATCH_VERSION,
    patch_version_number: versionNumber(PATCH_VERSION),
    agent_version: 3,
    auth: "hmac-sha256:X-Sync-Signature",
    endpoints: [
      { kind: "sync_now", url: origin + "/api/public/portal/sync-now" },
      { kind: "master_sync", url: origin + "/api/public/hooks/master-sync" },
      { kind: "version", url: origin + "/api/public/portal/version" },
      { kind: "announce", url: origin + "/api/public/portal/announce" },
    ],
    announced_at: new Date().toISOString(),
  };

  const secret = process.env.MASTER_SYNC_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "MASTER_SYNC_SECRET missing", card }, { status: 200 });
  }

  const body = JSON.stringify({ card });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const res = await fetch(MASTER + "/api/public/imsp/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Signature": signature },
      body,
    });
    const json = await res.json().catch(() => null);
    return Response.json({ ok: res.ok, status: res.status, master: json?.master ?? null, card });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "announce failed", card },
      { status: 200 },
    );
  }
}
