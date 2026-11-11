# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Multi-tenant CMS with built-in AI: each site (tenant) can have Claude write and publish articles and design the site's look. TypeScript on Node 22 (ESM), Express 5, built-in `node:sqlite`, Zod 4, `@anthropic-ai/sdk`, `openai`. Admin UI: React 19 + React Router 8 (lazy-loaded routes), built with Vite 8.

## Commands

```bash
pnpm install
pnpm seed          # tenants "demo" (AI may auto-publish) + "acme" (AI output needs review); login admin@example.com / password123
pnpm dev           # http://localhost:3000/admin — tsx watch + Vite middleware (HMR), one port
pnpm build         # builds the React admin to dist/admin (needed for `pnpm start`)
pnpm start         # NODE_ENV=production: serves dist/admin
pnpm test          # node:test via tsx — unit + HTTP integration tests, no network
pnpm typecheck     # tsc for the server (tsconfig.json) and the admin (admin/tsconfig.json)

# one file / one test by name (put the flag before the file):
NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm exec tsx --test --test-name-pattern="sniffImage" test/unit.test.ts
```

pnpm is the package manager (`pnpm-lock.yaml`); the README's `npm run ...` commands also work. Run `pnpm typecheck` and `pnpm test` before committing.

Tests: `test/unit.test.ts` covers pure functions, plus the Anthropic/OpenAI providers given a fake SDK client through their constructor (`new AnthropicProvider(client)`). `test/app.test.ts` builds one app for the whole file with `createApp({ db: openDb(":memory:"), provider: new MockProvider(), providerFactory })`, starts it on a random port, and drives the admin through its JSON API (`/admin/api`), not the browser UI. Tests in that file share the DB, so state carries over from one test to the next. They never call a real API. `createApp`'s options (`db`, `provider`, `providerFactory`, `adminUi`) are the injection points.

Config comes from env vars, loaded from `.env` if present (see `.env.example`; real env vars win; not loaded under `node --test`). Without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` the app uses the offline mock AI. Other vars: `AI_PROVIDER`, `AI_MODEL`, `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL`, `DB_PATH`, `BASE_DOMAIN`, `APP_SECRET`, `PORT`, `NODE_ENV` (see `src/config.ts`). Don't leave optional vars set to an empty string (e.g. `AI_PROVIDER=` breaks provider selection) — comment them out.

## Architecture

- `src/app.ts` — wires routers: `/api/v1` (bearer tokens); `/admin` session middleware, then `/admin/api` (JSON API), SSR previews, and the React admin (`adminUi`, passed in by `server.ts`; omitted in tests); then public sites by custom domain / `BASE_DOMAIN` subdomain, then `/s/:tenant`.
- `src/repo.ts` — all SQLite access. **Every tenant-owned query must filter by `tenant_id`**; there's a test for tenant isolation.
- `src/db.ts` — schema (created on open; no migration tool yet).
- `src/tenancy.ts` — roles (`author < editor < owner`), permission matrix, per-tenant settings schema (the AI policy), and `aiArticlePublishDecision` / `aiThemeApplyDecision`.
- `src/ai/` — `provider.ts` (interface + article schema), `prompts.ts` (system/user prompts shared by all providers), `anthropic.ts` (Claude), `openai.ts` (OpenAI Responses API), `mock.ts` (offline), `service.ts` (policy checks, background jobs, saving results).
- `src/content/blocks.ts` — articles are stored as typed blocks, not HTML; Markdown ⇄ blocks converter for the editor; safe renderer.
- `src/content/media.ts` — image rules: `sniffImage` (PNG/JPEG/WebP/GIF by magic bytes), `isImageUrl` (https or own `/media/...` path, no CSS-breaking characters), `mediaUrl`.
- `src/themes/spec.ts` + `src/themes/render.ts` — the shared template system (below).
- `src/themes/palette.ts` — parses user palettes (hex/rgb lists, CSS/SCSS vars, JSON, GIMP `.gpl`, Coolors URLs) and maps them onto the 8 theme color roles. A palette is input, not part of `ThemeSpec`.
- `src/web/` — `site.ts` (public pages, RSS), `api.ts` (public REST API, bearer tokens), and the admin backend:
  - `admin-api.ts` — JSON API for the React admin at `/admin/api` (login/signup/session, `/sites`, and per-tenant `/t/:tenant/...`: dashboard, articles, AI jobs, themes, palette, settings, members, tokens).
  - `admin-types.ts` — the request/response types shared with the client. **Import-free** so the browser bundle can `import type` it; server handlers annotate responses with these types so drift fails `tsc`.
  - `admin-previews.ts` — server-rendered article/theme previews (`/admin/:tenant/{articles,design}/:id/preview`), using the public theme renderer.
  - `admin-spa.ts` — serves the React admin: Vite middleware in dev, `dist/admin` + `index.html` fallback in production.
  - `media.ts` — public `GET /media/:tenant/:file` (mounted before the public sites, so it works on every host).
- `admin/` — the React admin (Vite root, `base: "/admin/"`, config in `vite.config.ts` at the repo root).
  - `src/main.tsx` — the shell (header, flash, loading bar) and the route table. Every page is `lazy: () => import("./routes/<page>")`, so each page is its own chunk loaded on first visit.
  - `src/routes/*.tsx` — one module per page, exporting `Component` and usually `loader`. `tenant.tsx` is the `/:tenant` layout (route id `"tenant"`); pages read its data with `useTenant()`.
  - `src/api.ts` — `api()` fetch wrapper (adds JSON + `X-CSRF-Token`), `load()` for loaders (a 401 redirects to `/login`), session store (`useSession`).
  - `src/media.tsx` — `ImagePicker` (upload / generate with AI / pick from library), used for article covers, body images and theme heroes.
  - `src/ui.tsx` — shared components, flash messages (`useFlash`, or `navigate(to, { state: { flash } })` across pages), `useAction()` for busy state + error flash.

## Rules to keep

- **Template system:** a theme is only a `ThemeSpec` (tokens + choices from fixed enums). One renderer (`render.ts`) and one `BASE_CSS` serve every theme. Never let AI or users inject raw HTML/CSS. To add a design option: add it to `ThemeSpecSchema`, `AiThemeSchema`, `normalizeTheme`, the CSS/classes in `render.ts`, and describe it in `THEME_SYSTEM` in `ai/prompts.ts`.
- **AI output is untrusted:** AI themes go through `normalizeTheme` (clamps/falls back); article blocks are validated by Zod. Rendering escapes everything — use the `html` tagged template from `src/util/html.ts` (only `raw()` skips escaping) and `safeUrl` for links/images.
- **Publishing policy lives in `tenancy.ts`.** AI articles only go live if the request asked for it, the tenant allows auto-publish, and the requester's role meets `minRoleToAutoPublish`; otherwise `review`/`draft`. Same pattern for applying themes. Don't bypass these from routes.
- **Claude calls** (`ai/anthropic.ts`): `client.beta.messages.parse` with `betaZodOutputFormat`, `output_config.effort` from tenant settings, cached system prompt, and server-side refusal fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). Check `stop_reason` (`refusal`, `max_tokens`) before using output. Default model `claude-opus-5-5`; Opus 5.5 rejects `thinking: {type: "disabled"}`, `budget_tokens` and forced `tool_choice` — control depth with effort. Keep system prompts byte-stable (no timestamps) so caching works.
- **Public sites stay server-rendered.** React is only for the admin. Public pages and previews go through `render.ts` (SEO, one renderer for all themes); don't render tenant themes in React.
- **Per-tenant LLM provider:** `settings.ai.provider` is `"default"` (platform provider from env) or one of `AI_PROVIDERS`. A tenant's own API key lives encrypted (`util/secrets.ts`, keyed from `APP_SECRET`) in `tenants.ai_api_key` — never in settings JSON, never rendered unmasked; `Tenant` only exposes `hasAiKey`. `AiService.providerFor(t)` resolves it (tenant key, else platform key). To add a provider: extend `AI_PROVIDERS`, `defaultProviderFactory`, and `PROVIDER_LABELS` in `admin-api.ts`; reuse `ai/prompts.ts`.
- **OpenAI calls** (`ai/openai.ts`): `client.responses.parse` with `zodTextFormat` (strict schema), `reasoning.effort` from tenant settings, `store: false`; check refusal parts and `status: "incomplete"` before using output. Sites default to a Claude model, so each provider swaps in its own default when given the other's model name (`openAiModelFor` → `OPENAI_MODEL`, default `gpt-5.5`; `anthropicModelFor`).
- **Admin API security:** `sessionMiddleware` checks the CSRF token (`X-CSRF-Token` header, from `GET /admin/api/session` or the login response) on every non-GET request; `admin-api.ts` also requires `application/json` on POST/PUT, which blocks cross-site HTML form posts. Tenant routes check permissions with `need(...)`/`can(...)` on the server; the client's `tenant.can[...]` only hides UI. Errors are JSON `{ error }` with a proper status (throw `HttpError` or `PolicyError`).
- **Adding an admin page:** add an endpoint in `admin-api.ts` with types in `admin-types.ts`, a `admin/src/routes/<page>.tsx` module (`loader` + `Component`), and a `lazy` route in `main.tsx`. After mutations call `useRevalidator().revalidate()` (or navigate) instead of keeping copies of loader data.
- **Images** (uploads and AI) live in the tenant-scoped `media` table (bytes as BLOB) and are referenced by URL: `articles.image_url` (cover), `![alt](url)` image blocks, and `ThemeSpec.hero.imageUrl`. Validate URLs with `isImageUrl` and uploads/AI output with `sniffImage`; never accept SVG. Uploads are the one non-JSON admin POST (`POST /t/:tenant/media`, raw `image/*` body, still CSRF-checked). Claude can't make images: `AiService.imageProviderFor` uses the tenant's provider if it implements `generateImage` (OpenAI, mock), else the platform OpenAI key, else a 409. Image generation is synchronous (not an `ai_jobs` job); AI article/theme jobs can add a cover/hero (`coverImage`/`heroImage`) and save without it if image generation fails. Monthly quota: `settings.ai.images.monthlyLimit`.
- ESM: server imports use `.js` extensions; no `__dirname`. Client imports (in `admin/`) are extensionless (bundler resolution).

## Known gaps

AI jobs run in-process (a restart fails unfinished jobs); images are stored in SQLite (fine for small sites; move to object storage for scale) and are never resized; deleting an image doesn't check where it's used; no login rate limiting or password reset; no DB migrations (only `addColumnIfMissing`).
