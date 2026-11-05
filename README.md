# AICMS — multi-tenant CMS with built-in AI

Each site (tenant) can:

- **Ask AI to write an article** on any topic. Whether the article goes live straight away or waits for review is set by that site's **AI policy**.
- **Ask AI to design the site** ("a calm Japanese-inspired look, serif headings, magazine homepage"). The AI fills in a theme spec for a **template system shared by every site**, so every generated look is safe, responsive and works with any content.
- Optionally give **one article its own AI-designed look**.

## Quick start

```bash
npm install
npm run seed      # demo sites "demo" (AI may auto-publish) and "acme" (AI output needs review)
npm run dev       # http://localhost:3000/admin  — admin@example.com / password123
```

Without an API key the app runs a **mock AI** (offline, gives placeholder text). To use Claude:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

| Env var | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `anthropic` if a key is set, else `mock` | Which AI backend to use |
| `AI_MODEL` | `claude-opus-5-5` | Default model for new sites (each site can override it) |
| `DB_PATH` | `data/aicms.sqlite` | SQLite file |
| `BASE_DOMAIN` | – | Turns on subdomain tenancy: `acme.example.com` → site `acme` |
| `APP_SECRET` | random | Signs CSRF tokens; set it in production |
| `PORT` | `3000` | |

## How it fits together

```
src/
  themes/spec.ts      ThemeSpec: design tokens + a fixed set of layout choices; presets; normalizeTheme()
  themes/render.ts    The ONE layout engine + base stylesheet used by every theme
  content/blocks.ts   Articles are typed blocks (heading, paragraph, list, quote, code, callout, image…)
                      plus a Markdown <-> blocks converter for human editing
  ai/provider.ts      AIProvider interface + article schema
  ai/anthropic.ts     Claude: structured outputs (Zod), adaptive thinking, effort, refusal fallbacks
  ai/mock.ts          Offline generator for demos and tests
  ai/service.ts       Policy checks, background jobs, saving results per site settings
  tenancy.ts          Roles, permissions, per-site settings schema, publish/apply decisions
  repo.ts             SQLite data access (every query is scoped by tenant_id)
  web/site.ts         Public sites: custom domain, subdomain or /s/<slug>
  web/admin.ts        Admin UI (dashboard, articles, design, settings, members, API tokens)
  web/api.ts          REST API with bearer tokens for each site
```

### Template system
A theme is JSON only: colors, fonts (from a fixed list), type scale, radius, card style, density, header style (`left | centered | split | minimal | bold-band`), home layout (`grid | list | magazine | cards | minimal`), article layout (`classic | wide | sidebar` with a table of contents), hero, background texture, nav and footer. `render.ts` turns that into CSS variables and modifier classes on the same markup. The AI never writes HTML or CSS. Its output is checked against a schema and out-of-range values are clamped, so a bad generation cannot break a site.

### AI policy (per site, Settings page)
- AI on/off, model, effort, and the lowest role allowed to use AI
- **Allow AI to publish articles directly**, plus the lowest role that may request it. When this is off, AI articles go to the *review* queue.
- **Allow AI themes to be applied immediately**, plus the lowest role. When this is off, themes are saved for someone to preview and apply.
- Monthly AI article limit, language, default tone and length, and **brand voice** (sent with every request)

### Roles
`author` can write drafts and send them for review. `editor` can also publish, edit any article and manage design. `owner` can also change settings, members and API tokens.

### REST API
```bash
curl -X POST localhost:3000/api/v1/ai/articles?wait=1 \
  -H "Authorization: Bearer cms_..." -H "Content-Type: application/json" \
  -d '{"topic":"Why cities are rediscovering trams","publish":true,"designLook":"industrial, urban"}'
```
Endpoints: `GET/POST /api/v1/articles`, `GET /api/v1/articles/:id`, `POST /api/v1/ai/articles`, `POST /api/v1/ai/themes`, `GET /api/v1/jobs/:id`. Without `?wait=1`, a request returns `202` with a job to poll.

## Tests
```bash
npm test          # unit + HTTP integration tests (mock AI and a fake Claude client; no network)
npm run typecheck
```
