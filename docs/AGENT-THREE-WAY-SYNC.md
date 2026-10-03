# Three-way agent sync (Lovable ⇄ GitHub ⇄ Cursor/Merlin)

Portal: `pulse`  ·  Repo: `vivekearthz/Innovexsis`

## How work arrives
Lovable (the MarTech master) commits one Markdown brief per task to:

    .agent-tasks/queue/<task-id>--<slug>.md

Each brief has YAML front-matter with `task_id`, `assignee`, `category`,
`portal_key` and `priority`, followed by the requirement, acceptance criteria
and the files most likely involved.

## How to work a task (Cursor)
1. `git pull` and open the newest file in `.agent-tasks/queue/`.
2. Use @Repo context; implement the change across as many files as needed.
3. Run typecheck/tests locally. Keep the existing architecture:
   TanStack Start + React 19 + Tailwind v4 + Supabase (RLS on),
   server logic in `createServerFn` / `src/routes/api/public/*` only.
   Never add another router, never commit secrets, never bypass RLS.
4. Commit your code changes normally.

## How to report back (mandatory)
Commit a JSON result file at:

    .agent-tasks/results/<task-id>.json

```json
{
  "task_id": "<uuid from the brief>",
  "status": "completed",            // or "failed" | "in_progress"
  "agent": "cursor",                // or "merlin"
  "summary": "One-paragraph what changed and why",
  "files_changed": ["src/lib/foo.server.ts"],
  "commit": "<sha>",
  "notes": "follow-ups / risks",
  "completed_at": "2026-01-01T00:00:00Z"
}
```

Lovable polls this directory (and accepts a signed webhook push), records the
result against the task, re-dispatches anything stale, and republishes the
fleet so every portal picks the change up.

## Rules of engagement
- Cursor owns: complex backend logic, DB migrations, integrations, deep
  debugging, refactors, tests, performance, security hardening, typing.
- Merlin owns: research, documentation, SEO/content research.
- Lovable owns: UI/UX generation and rapid frontend iteration.
- Do not edit `src/routeTree.gen.ts`, `src/integrations/supabase/*` generated
  files, or `.env`.
