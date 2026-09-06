import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// MARTECH "born-wired" slave agent.
// Master owns this file — do not hand-edit; drift is overwritten on next sync.
// ---------------------------------------------------------------------------

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "pulse";
const MASTER = process.env.MASTER_BASE_URL ?? "https://martech.innovexsis.com";

const CONFIG_REFRESH_COMMANDS = new Set<string>([
  "republish",
  "refresh_config",
  "restore_connector_continuity",
  "sync_now",
]);

function sign(body: string) {
  const secret = process.env.MASTER_SYNC_SECRET;
  if (!secret) throw new Error("MASTER_SYNC_SECRET is not configured");
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function callMaster(path: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${MASTER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Signature": sign(raw) },
    body: raw,
  });
  if (!res.ok) throw new Error(`master ${path} -> ${res.status}`);
  return res.json();
}

async function safeCall(path: string, payload: Record<string, unknown>) {
  try {
    return await callMaster(path, payload);
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/hooks/master-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const slaveUrl = new URL(request.url).origin;

        const boot = await callMaster("/api/public/portal/bootstrap", {
          product: PRODUCT,
          slave_url: slaveUrl,
        });

        const instr = (await safeCall("/api/public/portal/instructions", {
          product: PRODUCT,
        })) as { commands?: Array<{ id: string; command: string }> } | null;

        let acked = 0;
        for (const cmd of instr?.commands ?? []) {
          if (!cmd?.id || !CONFIG_REFRESH_COMMANDS.has(cmd.command)) continue;
          const ok = await safeCall("/api/public/portal/command-ack", {
            product: PRODUCT,
            command_id: cmd.id,
            status: "acked",
            result: { applied_via: "master-sync", at: new Date().toISOString() },
          });
          if (ok) acked += 1;
        }

        await safeCall("/api/public/portal/heartbeat", {
          portal_key: PRODUCT,
          payload: {
            slave_url: slaveUrl,
            commands_seen: instr?.commands?.length ?? 0,
            commands_acked: acked,
            at: new Date().toISOString(),
          },
        });

        return Response.json({
          ok: true,
          brand_id: boot.brand_id,
          synced: true,
          commands_acked: acked,
        });
      },
    },
  },
});
