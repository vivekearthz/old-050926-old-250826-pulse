import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// MARTECH "born-wired" slave: sync-now webhook.
// Master POSTs a signed nudge -> slave verifies HMAC, then fires its
// master-sync agent (fire-and-forget) to pull the latest config bundle.
// Master owns this file - do not hand-edit.
// ---------------------------------------------------------------------------

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "pulse";

function verify(raw: string, header: string | null): boolean {
  const secret = process.env.MASTER_SYNC_SECRET;
  if (!secret || !header) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  try {
    const a = Buffer.from(header, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/public/portal/sync-now")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Sync-Signature",
          },
        }),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!verify(raw, request.headers.get("X-Sync-Signature"))) {
          return new Response("Invalid signature", { status: 401 });
        }
        try {
          const origin = new URL(request.url).origin;
          void fetch(`${origin}/api/public/hooks/master-sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trigger: "sync_now" }),
          });
        } catch {
          /* non-fatal */
        }
        return Response.json({
          ok: true,
          ack: "sync_now",
          product: PRODUCT,
          at: new Date().toISOString(),
        });
      },
    },
  },
});
