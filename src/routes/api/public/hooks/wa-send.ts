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

function e164(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

async function sendDirect(
  to: string,
  text: string,
  template: string | null,
  values: string[],
): Promise<{ ok: boolean; via: string; messageId?: string; error?: string }> {
  const base = process.env.EMOVUR_BASE_URL;
  const key = process.env.EMOVUR_API_KEY;
  const phoneId = process.env.EMOVUR_PHONE_NUMBER_ID;
  if (!base || !key || !phoneId) {
    return { ok: false, via: "none", error: "no local whatsapp credentials" };
  }

  const payload = template
    ? {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: process.env.EMOVUR_OTP_TEMPLATE_LANG ?? "en" },
          components: values.length
            ? [{ type: "body", parameters: values.map((v) => ({ type: "text", text: v })) }]
            : [],
        },
      }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: text } };

  let lastError = "whatsapp send failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/${phoneId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = await res.text().catch(() => "");
      if (res.ok) {
        let messageId: string | undefined;
        try {
          messageId = JSON.parse(body)?.messages?.[0]?.id;
        } catch {
          /* provider returned non-json success */
        }
        return { ok: true, via: "direct:emovur", messageId };
      }
      lastError = `emovur ${res.status} ${body.slice(0, 160)}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "emovur error";
    }
    if (attempt < 3) await sleep(attempt * 900);
  }
  return { ok: false, via: "direct:emovur", error: lastError };
}

export const Route = createFileRoute("/api/public/hooks/wa-send")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          contract: {
            method: "POST",
            headers: { "X-Sync-Signature": "hmac-sha256 of raw body with MASTER_SYNC_SECRET" },
            body: { to: "+919999999999", text: "message", template: "optional", values: ["a"] },
          },
          direct_capable: Boolean(process.env.EMOVUR_API_KEY && process.env.EMOVUR_PHONE_NUMBER_ID),
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

        const to = e164(payload.to);
        if (!to) return Response.json({ ok: false, error: "invalid recipient" }, { status: 400 });
        const text = String(payload.text ?? "");
        const template = payload.template ? String(payload.template) : null;
        const values = Array.isArray(payload.values) ? payload.values.map((v) => String(v)) : [];
        if (!template && !text) {
          return Response.json({ ok: false, error: "text or template required" }, { status: 400 });
        }

        const direct = await sendDirect(to, text, template, values);
        if (direct.ok) {
          return Response.json({ ok: true, via: direct.via, message_id: direct.messageId ?? null });
        }

        const body = JSON.stringify({ ...payload, to, portal_key: PRODUCT });
        let lastError = direct.error ?? "relay failed";
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await fetch(`${MASTER}/api/public/hooks/wa-relay`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Sync-Signature": sign(body) },
              body,
            });
            const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (res.ok && json && json.ok === true) {
              return Response.json({ ok: true, via: "master_wa_relay", detail: json });
            }
            lastError = `master ${res.status}`;
          } catch (err) {
            lastError = err instanceof Error ? err.message : "relay error";
          }
          if (attempt < 3) await sleep(attempt * 900);
        }
        return Response.json(
          { ok: false, via: "direct+master", error: lastError, retry: true },
          { status: 502 },
        );
      },
    },
  },
});
