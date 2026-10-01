import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// MARTECH slave: OUTBOUND EMAIL — DIRECT-FIRST, MASTER-OPTIONAL (Policy v74).
//
// v69 relayed every message through the master, so a master outage or a paused
// master database stopped all slave email. v74 removes that single point of
// failure: if this portal holds ANY provider key of its own it sends DIRECTLY,
// rotating across providers with retry/backoff, and only falls back to the
// master relay when it holds no keys or every local provider failed.
//
// Local app code calls THIS route (same-origin, signed, no browser secrets):
//   POST /api/public/hooks/email-send { to, subject, html, text? }
//
// Master owns this file - do not hand-edit; drift is overwritten on next sync.
// ---------------------------------------------------------------------------

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "old250826pulse";
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

type Mail = { to: string; subject: string; html?: string; text?: string };

function fromAddress(): string {
  return (
    process.env.EMAIL_FALLBACK_FROM ??
    process.env.EMAIL_BROADCAST_FROM ??
    "director@innovexsis.com"
  );
}

// Direct provider ladder. Each entry is skipped when its key is absent, so a
// portal with one key still sends, and a portal with none relays to master.
async function sendDirect(m: Mail): Promise<{ ok: boolean; via: string; error?: string }> {
  const from = fromAddress();
  const html = m.html ?? `<p>${m.text ?? ""}</p>`;
  const text = m.text ?? "";

  const providers: Array<{ name: string; run: () => Promise<Response> }> = [];

  if (process.env.BREVO_API_KEY) {
    providers.push({
      name: "brevo",
      run: () =>
        fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": process.env.BREVO_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sender: { email: from },
            to: [{ email: m.to }],
            subject: m.subject,
            htmlContent: html,
          }),
        }),
    });
  }
  if (process.env.MAILERSEND_API_KEY) {
    providers.push({
      name: "mailersend",
      run: () =>
        fetch("https://api.mailersend.com/v1/email", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MAILERSEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: { email: from },
            to: [{ email: m.to }],
            subject: m.subject,
            html,
            text,
          }),
        }),
    });
  }
  if (process.env.SENDGRID_API_KEY) {
    providers.push({
      name: "sendgrid",
      run: () =>
        fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: m.to }] }],
            from: { email: from },
            subject: m.subject,
            content: [{ type: "text/html", value: html }],
          }),
        }),
    });
  }
  if (process.env.ELASTICEMAIL_API_KEY) {
    providers.push({
      name: "elasticemail",
      run: () =>
        fetch("https://api.elasticemail.com/v4/emails/transactional", {
          method: "POST",
          headers: {
            "X-ElasticEmail-ApiKey": process.env.ELASTICEMAIL_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            Recipients: { To: [m.to] },
            Content: {
              From: from,
              Subject: m.subject,
              Body: [{ ContentType: "HTML", Content: html }],
            },
          }),
        }),
    });
  }

  if (!providers.length) return { ok: false, via: "none", error: "no local provider keys" };

  let lastError = "direct send failed";
  for (const p of providers) {
    // Two attempts per provider: transient 429/5xx heals itself on retry.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await p.run();
        if (res.ok) return { ok: true, via: `direct:${p.name}` };
        const body = await res.text().catch(() => "");
        lastError = `${p.name} ${res.status} ${body.slice(0, 160)}`;
        const transient = res.status === 429 || res.status >= 500;
        if (!transient) break;
      } catch (err) {
        lastError = `${p.name} ${err instanceof Error ? err.message : "error"}`;
      }
      if (attempt < 2) await sleep(attempt * 800);
    }
  }
  return { ok: false, via: "direct", error: lastError };
}

export const Route = createFileRoute("/api/public/hooks/email-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        // Public route: require the shared signature so this can never be used
        // as an open mail relay by anonymous callers.
        if (!localCallerOk(raw, request.headers.get("X-Sync-Signature"))) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }

        const to = String(payload.to ?? "").trim();
        const subject = String(payload.subject ?? "").trim();
        if (!to || !subject) {
          return Response.json({ ok: false, error: "to and subject are required" }, { status: 400 });
        }

        // 1) Direct to the providers this portal holds keys for.
        const direct = await sendDirect({
          to,
          subject,
          html: payload.html ? String(payload.html) : undefined,
          text: payload.text ? String(payload.text) : undefined,
        });
        if (direct.ok) return Response.json({ ok: true, via: direct.via });

        // 2) Master relay as a fallback only — never the only path.
        const body = JSON.stringify({ ...payload, portal_key: PRODUCT });
        let lastError = direct.error ?? "relay failed";
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await fetch(`${MASTER}/api/public/hooks/email-relay`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Sync-Signature": sign(body) },
              body,
            });
            const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
            if (res.ok && json && json.ok === true) {
              return Response.json({ ok: true, via: "master_email_relay", detail: json });
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
