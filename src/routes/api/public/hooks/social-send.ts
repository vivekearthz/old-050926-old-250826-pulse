import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "pulse";
const MASTER = process.env.MASTER_BASE_URL ?? "https://martech.innovexsis.com";

function sign(body: string) {
  const secret = process.env.MASTER_SYNC_SECRET;
  if (!secret) throw new Error("MASTER_SYNC_SECRET is not configured");
  return createHmac("sha256", secret).update(body).digest("hex");
}

function localCallerOk(raw: string, header: string | null): boolean {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(run: () => Promise<Response>): Promise<{ ok: boolean; error?: string }> {
  let lastError = "post failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await run();
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      lastError = `${res.status} ${body.slice(0, 160)}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "post error";
    }
    if (attempt < 3) await sleep(attempt * 800);
  }
  return { ok: false, error: lastError };
}

async function postDirect(channel: string, copy: string) {
  if (channel === "telegram" && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return withRetry(() =>
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: copy }),
      }),
    );
  }
  if (channel === "discord" && process.env.DISCORD_WEBHOOK_URL) {
    return withRetry(() =>
      fetch(process.env.DISCORD_WEBHOOK_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: copy }),
      }),
    );
  }
  return null;
}

export const Route = createFileRoute("/api/public/hooks/social-send")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          contract: {
            method: "POST",
            headers: { "X-Sync-Signature": "hmac-sha256 of raw body with MASTER_SYNC_SECRET" },
            body: { channels: ["linkedin", "telegram"], copy: "post text", cta_url: "https://..." },
          },
        }),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!localCallerOk(raw, request.headers.get("X-Sync-Signature"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }

        const copy = String(payload.copy ?? "").trim();
        const channels = Array.isArray(payload.channels)
          ? payload.channels.map((c) => String(c).toLowerCase())
          : [];
        if (!copy || !channels.length) {
          return Response.json({ ok: false, error: "copy and channels required" }, { status: 400 });
        }

        const results: Record<string, { ok: boolean; via: string; error?: string }> = {};
        const remaining: string[] = [];
        for (const channel of channels) {
          const direct = await postDirect(channel, copy);
          if (direct) results[channel] = { ...direct, via: "direct" };
          else remaining.push(channel);
        }

        if (remaining.length) {
          const body = JSON.stringify({ ...payload, channels: remaining, portal_key: PRODUCT });
          let lastError = "relay failed";
          let relayed = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await fetch(`${MASTER}/api/public/hooks/social-relay`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Sync-Signature": sign(body) },
                body,
              });
              const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
              if (res.ok && json) {
                relayed = true;
                for (const channel of remaining) {
                  results[channel] = { ok: true, via: "master_social_relay" };
                }
                break;
              }
              lastError = `master ${res.status}`;
            } catch (err) {
              lastError = err instanceof Error ? err.message : "relay error";
            }
            if (attempt < 3) await sleep(attempt * 900);
          }
          if (!relayed) {
            for (const channel of remaining) {
              results[channel] = { ok: false, via: "master_social_relay", error: lastError };
            }
          }
        }

        const anyOk = Object.values(results).some((r) => r.ok);
        return Response.json({ ok: anyOk, results }, { status: anyOk ? 200 : 502 });
      },
    },
  },
});
