# Vinv (Vibe Inverse) — runtime observability for coding agents

Portal: `pulse` · Repo: `vivekearthz/pulse` · Upstream: https://github.com/VinvAI/VinvAI (Apache-2.0)
Extension: https://open-vsx.org/extension/VinvAI/VinvAI

Vinv is an IDE plugin that **runs the service, finds issues, and verifies fixes
without changing code**. It links runtime traces back to the source that produced
them, hands that context to the coding agent, then re-runs the code to check the
fix actually works. It auto-exposes its **MCP** tools to every coding harness you
have (Cursor, VS Code, Merlin, Lovable agent bus). Everything runs locally.

## Install once per machine
1. Install the extension: https://open-vsx.org/extension/VinvAI/VinvAI (VS Code / Cursor / any Open VSX host).
2. Open this repo — `.vinv/vinv.config.json` is already committed, so Vinv
   knows how to boot the service (`bun run dev`, ready on :8080) and what to redact.
3. Vinv publishes its MCP server at `http://127.0.0.1:7801/mcp`; Cursor picks it up
   automatically, no per-harness wiring needed.

## Mandatory loop for every agent task
When you work a brief from `.agent-tasks/queue/`:
1. `vinv.run_service` — boot the app before editing.
2. `vinv.reproduce_issue` — capture the failing trace and its source lines.
3. Implement the fix using that runtime context (NOT guesses from static reading).
4. `vinv.verify_fix` — re-run and confirm the trace is gone.
5. Put the verification output in the result JSON:
   `"verification": { "tool": "vinv", "reproduced": true, "verified": true, "evidence": "..." }`.

A result without Vinv verification is accepted but marked *unverified* by the
master and may be re-dispatched.

## Context budget
Vinv uses Thompson sampling to decide how much runtime context to inject — more
context is not always better. Do not override `context.policy`; let it learn.

## Guardrails
- Local only: no source upload, secrets/headers redacted via `trace.redact`.
- Never commit trace dumps; they belong in the result JSON summary or the
  master hook `/api/public/hooks/vinv-trace`.
