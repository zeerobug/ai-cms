# CLAUDE.md

Multi-tenant CMS with built-in AI: each site (tenant) can have Claude write and publish articles and design the site's look. TypeScript on Node 22 (ESM), Express 5, built-in `node:sqlite`, Zod 4, `@anthropic-ai/sdk`.

## Commands

```bash
npm install
npm run seed       # demo tenants "demo" + "acme"; login admin@example.com / password123
npm run dev        # http://localhost:3000/admin (tsx watch)
npm test           # node:test via tsx — unit + HTTP integration tests, no network
npm run typecheck  # tsc --noEmit
```

Run `npm run typecheck` and `npm test` before committing. Tests use an in-memory DB (`DB_PATH=:memory:` via `openDb(":memory:")`) and `MockProvider`; they never call the real API.

Without `ANTHROPIC_API_KEY` the app uses the offline mock AI (`AI_PROVIDER=mock`). Other env vars: `AI_MODEL`, `DB_PATH`, `BASE_DOMAIN`, `APP_SECRET`, `PORT` (see `src/config.ts`).

## Architecture

- `src/app.ts` — wires routers: `/api/v1` (bearer tokens), `/admin` (session + CSRF), public sites by custom domain / `BASE_DOMAIN` subdomain, then `/s/:tenant`.
- `src/repo.ts` — all SQLite access. **Every tenant-owned query must filter by `tenant_id`**; there's a test for tenant isolation.
- `src/db.ts` — schema (created on open; no migration tool yet).
- `src/tenancy.ts` — roles (`author < editor < owner`), permission matrix, per-tenant settings schema (the AI policy), and `aiArticlePublishDecision` / `aiThemeApplyDecision`.
- `src/ai/` — `provider.ts` (interface + article schema), `anthropic.ts` (Claude), `mock.ts` (offline), `service.ts` (policy checks, background jobs, saving results).
- `src/content/blocks.ts` — articles are stored as typed blocks, not HTML; Markdown ⇄ blocks converter for the editor; safe renderer.
- `src/themes/spec.ts` + `src/themes/render.ts` — the shared template system (below).
- `src/web/` — `site.ts` (public pages, RSS), `admin.ts` + `admin-ui.ts` (server-rendered admin), `api.ts` (REST).

## Rules to keep

- **Template system:** a theme is only a `ThemeSpec` (tokens + choices from fixed enums). One renderer (`render.ts`) and one `BASE_CSS` serve every theme. Never let AI or users inject raw HTML/CSS. To add a design option: add it to `ThemeSpecSchema`, `AiThemeSchema`, `normalizeTheme`, the CSS/classes in `render.ts`, and describe it in `THEME_SYSTEM` in `ai/anthropic.ts`.
- **AI output is untrusted:** AI themes go through `normalizeTheme` (clamps/falls back); article blocks are validated by Zod. Rendering escapes everything — use the `html` tagged template from `src/util/html.ts` (only `raw()` skips escaping) and `safeUrl` for links/images.
- **Publishing policy lives in `tenancy.ts`.** AI articles only go live if the request asked for it, the tenant allows auto-publish, and the requester's role meets `minRoleToAutoPublish`; otherwise `review`/`draft`. Same pattern for applying themes. Don't bypass these from routes.
- **Claude calls** (`ai/anthropic.ts`): `client.beta.messages.parse` with `betaZodOutputFormat`, `output_config.effort` from tenant settings, cached system prompt, and server-side refusal fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). Check `stop_reason` (`refusal`, `max_tokens`) before using output. Default model `claude-opus-5-5`; Opus 5.5 rejects `thinking: {type: "disabled"}`, `budget_tokens` and forced `tool_choice` — control depth with effort. Keep system prompts byte-stable (no timestamps) so caching works.
- Admin POST forms must include `csrfField(ctx)`; admin routes check permissions with `need(...)`/`can(...)`.
- ESM: imports use `.js` extensions; no `__dirname`.

## Known gaps

AI jobs run in-process (a restart fails unfinished jobs); no media uploads; no login rate limiting or password reset; no DB migrations.
