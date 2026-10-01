import { createFileRoute } from "@tanstack/react-router";

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "pulse";
const AGENT_VERSION = 3;
const PATCH_VERSION = "v74";

export const Route = createFileRoute("/api/public/portal/version")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          {
            ok: true,
            portalKey: PRODUCT,
            role: "slave",
            agentVersion: AGENT_VERSION,
            patchVersion: PATCH_VERSION,
          },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
  },
});
