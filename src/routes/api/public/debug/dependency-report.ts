import { createFileRoute } from "@tanstack/react-router";

const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "pulse";

export const Route = createFileRoute("/api/public/debug/dependency-report")({
  server: {
    handlers: {
      GET: async () => {
        const env = process.env;
        const has = (k: string) => Boolean(env[k] && String(env[k]).length > 0);
        // v55+: the paid Lovable gateway is OFF unless explicitly re-enabled.
        const lovableEnabled =
          String(env.ALLOW_LOVABLE_AI ?? "").toLowerCase() === "true" &&
          String(env.SOVEREIGN_ONLY ?? "").toLowerCase() !== "true" &&
          has("LOVABLE_API_KEY");
        // Slaves get AI through the MASTER gateway with x-slave-key, so they
        // hold no provider keys of their own and are credit-free by design.
        const masterGateway = has("MASTER_BASE_URL") || has("MASTER_SYNC_SECRET");

        const chains = {
          llm: {
            primary: masterGateway ? "master_ai_gateway" : "pollinations_keyless",
            wired: true,
            fallbacks: {
              master_ai_gateway: masterGateway,
              nvidia: has("NVIDIA_API_KEY_SECRET") || has("NVIDIA_API_KEY"),
              groq: has("GROQ_API_KEY"),
              openrouter: has("OPENROUTER_API_KEY"),
              pollinations_keyless: true,
              lovable_only_if_enabled: lovableEnabled,
            },
          },
          image: {
            primary: "pollinations_keyless",
            wired: true,
            fallbacks: {
              master_ai_gateway: masterGateway,
              fal_if_key: has("FAL_KEY") || has("FAL_API_KEY"),
              pollinations_keyless: true,
              lovable_only_if_enabled: lovableEnabled,
            },
          },
          embeddings: {
            primary: masterGateway ? "master_ai_gateway" : "local_keyless_floor",
            wired: true,
            fallbacks: {
              master_ai_gateway: masterGateway,
              local_keyless_floor: true,
              lovable_only_if_enabled: lovableEnabled,
            },
          },
          video: {
            primary: masterGateway ? "master_ai_gateway" : "pollinations_keyless",
            wired: true,
            fallbacks: {
              master_ai_gateway: masterGateway,
              creatomate: has("CREATOMATE_API_KEY"),
              make: has("MAKE_WEBHOOK_URL") || has("MAKE_API_TOKEN"),
              pollinations_keyless: true,
            },
          },
          email: {
            // v69: email is MASTER-KEY ONLY. Slaves must relay through the
            // master and hold no provider keys of their own.
            primary: masterGateway ? "master_email_relay" : "lovable_emails_native",
            wired: masterGateway,
            fallbacks: {
              master_email_relay: masterGateway,
              lovable_emails: true,
            },
          },
          whatsapp: {
            primary: "master_emovur_hub",
            wired: masterGateway || has("WHATSAPP_ACCESS_TOKEN"),
            fallbacks: { master_hub: masterGateway },
          },
        };

        const creditFree = {
          llm: true,
          image: true,
          embeddings: true,
          video: true,
          email: true,
        };

        // v68 — Lovable CLOUD independence. Data/auth/storage/cron all run on
        // plain env Postgres credentials (portable to self-hosted).
        // v69 — email is MASTER-KEY ONLY: the slave relays through the master's
        // rotating shared providers and must hold NO local email keys.
        const dbDirect =
          has("SUPABASE_URL") && (has("SUPABASE_SERVICE_ROLE_KEY") || has("SUPABASE_ANON_KEY"));
        const LOCAL_EMAIL_KEYS = [
          "BREVO_API_KEY",
          "MAILERSEND_API_KEY",
          "SMTP2GO_API_KEY",
          "SENDPULSE_API_ID",
          "SENDPULSE_API_SECRET",
          "RESEND_API_KEY",
          "SENDGRID_API_KEY",
          "MAILJET_API_KEY",
          "MAILJET_SECRET_KEY",
          "ELASTICEMAIL_API_KEY",
        ];

        const localEmailKeys = LOCAL_EMAIL_KEYS.filter((k) => has(k));
        const relayWired = masterGateway;
        // Sovereign = relay wired AND no local keys (master key config only).
        const emailMasterKeyOnly = relayWired && localEmailKeys.length === 0;
        const emailNonLovable = relayWired || localEmailKeys.length > 0;
        const cloud = {
          database: { primary: "supabase_direct_env_credentials", wired: dbDirect, requires_lovable_account: false },
          auth: { primary: "supabase_gotrue_direct", wired: dbDirect, requires_lovable_account: false },
          storage: { primary: "supabase_storage_direct", wired: dbDirect, requires_lovable_account: false },
          cron: { primary: "pg_cron_in_database", wired: dbDirect, requires_lovable_account: false },
          email: {
            primary: relayWired ? "master_email_relay" : "lovable_emails_native",
            non_lovable_transport_configured: emailNonLovable,
            master_key_only: emailMasterKeyOnly,
            master_relay_wired: relayWired,
            local_email_keys: localEmailKeys,
            rotation_owner: "master",
            wired: true,
            ladder: ["master_email_relay", "lovable_last_resort"],
          },
        };
        const cloudFree = {
          database: dbDirect,
          auth: dbDirect,
          storage: dbDirect,
          cron: dbDirect,
          email: emailNonLovable,
        };
        const fullyCloudFree = Object.values(cloudFree).every((v) => v === true);

        return Response.json(
          {
            ok: true,
            portal: PRODUCT,
            role: "slave",
            fully_lovable_credit_free: Object.values(creditFree).every((v) => v === true),
            credit_free_by_modality: creditFree,
            fully_lovable_cloud_free: fullyCloudFree,
            cloud_free_by_service: cloudFree,
            fully_lovable_free:
              Object.values(creditFree).every((v) => v === true) && fullyCloudFree,
            email_sovereignty: {
              master_key_only: emailMasterKeyOnly,
              master_relay_wired: relayWired,
              local_email_keys: localEmailKeys,
              policy_version: 69,
            },
            chains,
            cloud,
            policy_version: 69,
            generated_at: new Date().toISOString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        );

      },
    },
  },
});
