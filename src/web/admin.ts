import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { PolicyError, type AiService } from "../ai/service.js";
import { hashPassword, SESSION_COOKIE, setSessionCookie, verifyPassword } from "../auth.js";
import { blocksToMarkdown, markdownToBlocks, slugify } from "../content/blocks.js";
import type { ArticleRow, Repo } from "../repo.js";
import { safeJson } from "../repo.js";
import { can, ROLES, TenantSettingsSchema, type Permission, type Role, type TenantSettings } from "../tenancy.js";
import { renderArticle, renderHome } from "../themes/render.js";
import { normalizeTheme } from "../themes/spec.js";
import { html, raw } from "../util/html.js";
import { adminPage, csrfField, statusBadge, type AdminCtx } from "./admin-ui.js";
import { siteInfo } from "./site.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      role?: Role;
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const bool = (v: unknown) => v === "on" || v === "true" || v === "1";
const num = (v: unknown) => Number(v);

function ctx(req: Request, res: Response, section?: AdminCtx["section"]): AdminCtx {
  return {
    csrf: res.locals.csrf,
    userEmail: res.locals.user?.email,
    tenant: res.locals.tenant,
    role: res.locals.role,
    section,
    flash: typeof req.query.msg === "string" ? req.query.msg : undefined,
    error: typeof req.query.err === "string" ? req.query.err : undefined,
  };
}

const back = (res: Response, path: string, msg?: string, err?: string) => {
  const q = new URLSearchParams();
  if (msg) q.set("msg", msg);
  if (err) q.set("err", err);
  res.redirect(303, q.size ? `${path}?${q}` : path);
};

export function adminRouter(repo: Repo, ai: AiService) {
  const r = express.Router();

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  r.get("/login", (req, res) => {
    res.send(
      adminPage("Log in", ctx(req, res), html`<div class="panel" style="max-width:420px;margin:3rem auto">
        <h1>Log in</h1>
        <form method="post" action="/admin/login">
          <label>Email</label><input type="email" name="email" required autofocus>
          <label>Password</label><input type="password" name="password" required>
          <p><button>Log in</button></p>
        </form>
        <p class="muted">No account? <a href="/admin/signup">Create a site</a></p>
      </div>`),
    );
  });

  r.post("/login", (req, res) => {
    const user = repo.userByEmail(str(req.body.email));
    if (!user || !verifyPassword(str(req.body.password), user.password_hash)) return back(res, "/admin/login", undefined, "Invalid email or password.");
    setSessionCookie(res, repo.createSession(user.id));
    res.redirect(303, "/admin");
  });

  r.get("/signup", (req, res) => {
    res.send(
      adminPage("Create your site", ctx(req, res), html`<div class="panel" style="max-width:480px;margin:3rem auto">
        <h1>Create your site</h1>
        <form method="post" action="/admin/signup">
          <label>Your name</label><input name="name" required>
          <label>Email</label><input type="email" name="email" required>
          <label>Password (min 8 chars)</label><input type="password" name="password" minlength="8" required>
          <label>Site name</label><input name="site" required>
          <label>Site address (slug)</label><input name="slug" pattern="[a-z0-9-]+" placeholder="my-site" required>
          <p><button>Create site</button></p>
        </form>
      </div>`),
    );
  });

  r.post("/signup", (req, res) => {
    const email = str(req.body.email).trim().toLowerCase();
    const password = str(req.body.password);
    const slug = slugify(str(req.body.slug));
    if (password.length < 8) return back(res, "/admin/signup", undefined, "Password must be at least 8 characters.");
    if (repo.userByEmail(email)) return back(res, "/admin/signup", undefined, "That email already has an account; log in instead.");
    if (repo.tenantBySlug(slug)) return back(res, "/admin/signup", undefined, "That site address is taken.");
    const userId = repo.createUser(email, str(req.body.name), hashPassword(password));
    const t = repo.createTenant({ slug, name: str(req.body.site) || slug, ownerId: userId });
    setSessionCookie(res, repo.createSession(userId));
    back(res, `/admin/${t.slug}`, "Your site is ready. Ask the AI to write your first article!");
  });

  r.post("/logout", (_req, res) => {
    if (res.locals.sid) repo.deleteSession(res.locals.sid);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect(303, "/admin/login");
  });

  // Everything below requires a logged-in user.
  r.use((req, res, next) => {
    if (!res.locals.user) return res.redirect(303, "/admin/login");
    next();
  });

  r.get("/", (req, res) => {
    const sites = repo.tenantsForUser(res.locals.user!.id);
    res.send(
      adminPage("Your sites", ctx(req, res), html`<h1>Your sites</h1>
        <table><tr><th>Site</th><th>Role</th><th></th></tr>
        ${sites.map((s) => html`<tr><td><a href="/admin/${s.slug}">${s.name}</a> <span class="muted">/${s.slug}</span></td><td>${s.role}</td>
          <td><a href="/s/${s.slug}" target="_blank">View ↗</a></td></tr>`)}
        </table>
        <h2>Create another site</h2>
        <form method="post" action="/admin/sites" class="panel">${csrfField(ctx(req, res))}
          <div class="row"><div><label>Site name</label><input name="name" required></div>
          <div><label>Slug</label><input name="slug" pattern="[a-z0-9-]+" required></div></div>
          <p><button>Create</button></p>
        </form>`),
    );
  });

  r.post("/sites", (req, res) => {
    const slug = slugify(str(req.body.slug));
    if (repo.tenantBySlug(slug)) return back(res, "/admin", undefined, "That slug is taken.");
    const t = repo.createTenant({ slug, name: str(req.body.name) || slug, ownerId: res.locals.user!.id });
    back(res, `/admin/${t.slug}`, "Site created.");
  });

  // -------------------------------------------------------------------------
  // Tenant scope
  // -------------------------------------------------------------------------

  const t = express.Router({ mergeParams: true });
  r.use("/:tenant", (req: Request, res: Response, next: NextFunction) => {
    const tenant = repo.tenantBySlug(String(req.params.tenant));
    if (!tenant) return void res.status(404).send("Site not found");
    const role = repo.roleFor(res.locals.user!.id, tenant.id);
    if (!role) return void res.status(403).send("You don't have access to this site.");
    res.locals.tenant = tenant;
    res.locals.role = role;
    next();
  }, t);

  const need = (perm: Permission) => (_req: Request, res: Response, next: NextFunction) =>
    can(res.locals.role!, perm) ? next() : void res.status(403).send(`Your role (${res.locals.role}) can't do that.`);

  const base = (res: Response) => `/admin/${res.locals.tenant!.slug}`;

  const canEditArticle = (res: Response, a: ArticleRow) =>
    can(res.locals.role!, "article.editAny") || (a.author_id === res.locals.user!.id && a.status !== "published");

  // ---- Dashboard ----------------------------------------------------------

  t.get("/", (req, res) => {
    const tn = res.locals.tenant!;
    const c = ctx(req, res, "dashboard");
    const s = tn.settings.ai;
    const recent = repo.articles(tn.id, { limit: 8 });
    const jobs = repo.jobs(tn.id, 8);
    const autoPub = s.articles.autoPublish && can(res.locals.role!, "article.create") &&
      ROLES.indexOf(res.locals.role!) >= ROLES.indexOf(s.articles.minRoleToAutoPublish);
    res.send(
      adminPage("Dashboard", c, html`<h1>${tn.name}</h1>
      ${s.enabled ? aiArticleForm(c, base(res), tn.settings, autoPub, ai.provider.name) : html`<div class="panel">AI is disabled for this site.</div>`}
      <h2>Recent articles <a class="btn sm sec" href="${base(res)}/articles/new">+ New article</a></h2>
      ${articleTable(base(res), recent)}
      <h2>Recent AI jobs</h2>
      ${jobsTable(base(res), jobs)}`),
    );
  });

  // ---- AI requests --------------------------------------------------------

  t.post("/ai/article", (req, res) => {
    try {
      const jobId = ai.requestArticle(
        res.locals.tenant!,
        { userId: res.locals.user!.id, role: res.locals.role! },
        {
          topic: str(req.body.topic),
          instructions: str(req.body.instructions),
          tone: str(req.body.tone) || undefined,
          length: (["short", "medium", "long"].includes(str(req.body.length)) ? str(req.body.length) : undefined) as never,
          publish: bool(req.body.publish),
          designLook: bool(req.body.designLook) ? str(req.body.designBrief).trim() || true : false,
        },
      );
      res.redirect(303, `${base(res)}/jobs/${jobId}`);
    } catch (e) {
      back(res, base(res), undefined, errMsg(e));
    }
  });

  t.post("/ai/theme", need("design.manage"), (req, res) => {
    try {
      const jobId = ai.requestTheme(
        res.locals.tenant!,
        { userId: res.locals.user!.id, role: res.locals.role! },
        { prompt: str(req.body.prompt), apply: bool(req.body.apply), baseThemeId: num(req.body.baseThemeId) || undefined },
      );
      res.redirect(303, `${base(res)}/jobs/${jobId}`);
    } catch (e) {
      back(res, `${base(res)}/design`, undefined, errMsg(e));
    }
  });

  t.get("/jobs/:id.json", (req, res) => {
    const job = repo.job(res.locals.tenant!.id, num(req.params.id));
    if (!job) return void res.status(404).json({ error: "not found" });
    res.json({ ...job, input: safeJson(job.input, null), result: safeJson(job.result, null), usage: safeJson(job.usage, null) });
  });

  t.get("/jobs/:id", (req, res) => {
    const job = repo.job(res.locals.tenant!.id, num(req.params.id));
    if (!job) return void res.status(404).send("Job not found");
    const input = safeJson<Record<string, unknown>>(job.input, {});
    const b = base(res);
    res.send(
      adminPage(`AI job #${job.id}`, ctx(req, res, job.kind === "article" ? "articles" : "design"), html`
      <h1>AI ${job.kind} job #${job.id}</h1>
      <div class="panel"><p><strong>Request:</strong> ${String(input.topic ?? input.prompt ?? "")}</p>
        <div id="status"><span class="spinner"></span> Working… the AI is ${job.kind === "article" ? "writing" : "designing"}. This page updates automatically.</div>
      </div>
      <script>
      const b=${raw(JSON.stringify(b))};
      async function poll(){
        const r=await fetch(location.pathname+'.json');const j=await r.json();
        const el=document.getElementById('status');
        if(j.status==='succeeded'){
          const x=j.result;let h='<p>✅ '+esc(x.message)+'</p><div class="actions">';
          if(x.articleId){h+='<a class="btn" href="'+b+'/articles/'+x.articleId+'">Edit article</a> <a class="btn sec" href="'+b+'/articles/'+x.articleId+'/preview" target="_blank">Preview</a>';}
          if(x.themeId){h+=' <a class="btn sec" href="'+b+'/design/'+x.themeId+'/preview" target="_blank">Preview design</a> <a class="btn sec" href="'+b+'/design">Go to Design</a>';}
          el.innerHTML=h+'</div>'+(j.usage?'<p class="muted">'+j.usage.map(u=>esc(u.model)+': '+u.inputTokens+' in / '+u.outputTokens+' out tokens').join(' · ')+'</p>':'');
          return;
        }
        if(j.status==='failed'){el.innerHTML='<p>❌ '+esc(j.error||'Failed')+'</p><a class="btn sec" href="'+b+'">Back</a>';return;}
        setTimeout(poll,1500);
      }
      function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
      poll();
      </script>`),
    );
  });

  // ---- Articles -----------------------------------------------------------

  t.get("/articles", (req, res) => {
    const status = ["draft", "review", "published"].includes(str(req.query.status)) ? (str(req.query.status) as ArticleRow["status"]) : undefined;
    const rows = repo.articles(res.locals.tenant!.id, { status });
    const b = base(res);
    res.send(
      adminPage("Articles", ctx(req, res, "articles"), html`<h1>Articles <a class="btn sm" href="${b}/articles/new">+ New</a></h1>
      <p class="actions"><a href="${b}/articles">All</a> · <a href="${b}/articles?status=review">Needs review</a> ·
        <a href="${b}/articles?status=draft">Drafts</a> · <a href="${b}/articles?status=published">Published</a></p>
      ${articleTable(b, rows)}`),
    );
  });

  t.get("/articles/new", need("article.create"), (req, res) => {
    res.send(adminPage("New article", ctx(req, res, "articles"), articleForm(ctx(req, res), base(res), res.locals.role!, repo, res.locals.tenant!.id)));
  });

  t.post("/articles", need("article.create"), (req, res) => {
    const tn = res.locals.tenant!;
    const f = readArticleForm(req, res.locals.role!);
    const id = repo.createArticle(tn.id, { ...f, source: "human", authorId: res.locals.user!.id });
    back(res, `${base(res)}/articles/${id}`, "Article created.");
  });

  t.get("/articles/:id", (req, res) => {
    const tn = res.locals.tenant!;
    const a = repo.article(tn.id, num(req.params.id));
    if (!a) return void res.status(404).send("Not found");
    res.send(adminPage(a.title, ctx(req, res, "articles"), articleForm(ctx(req, res), base(res), res.locals.role!, repo, tn.id, a, canEditArticle(res, a))));
  });

  t.post("/articles/:id", (req, res) => {
    const tn = res.locals.tenant!;
    const a = repo.article(tn.id, num(req.params.id));
    if (!a) return void res.status(404).send("Not found");
    if (!canEditArticle(res, a)) return void res.status(403).send("You can't edit this article.");
    repo.updateArticle(tn.id, a.id, readArticleForm(req, res.locals.role!));
    back(res, `${base(res)}/articles/${a.id}`, "Saved.");
  });

  t.post("/articles/:id/status", (req, res) => {
    const tn = res.locals.tenant!;
    const a = repo.article(tn.id, num(req.params.id));
    if (!a) return void res.status(404).send("Not found");
    const status = str(req.body.status) as ArticleRow["status"];
    if (!["draft", "review", "published"].includes(status)) return void res.status(400).send("Bad status");
    const allowed = status === "published" ? can(res.locals.role!, "article.publish") : canEditArticle(res, a) || can(res.locals.role!, "article.publish");
    if (!allowed) return void res.status(403).send("Your role can't do that.");
    repo.setArticleStatus(tn.id, a.id, status);
    back(res, str(req.body.redirect).startsWith("/admin/") ? str(req.body.redirect) : `${base(res)}/articles/${a.id}`, `Status: ${status}.`);
  });

  t.post("/articles/:id/delete", need("article.delete"), (req, res) => {
    repo.deleteArticle(res.locals.tenant!.id, num(req.params.id));
    back(res, `${base(res)}/articles`, "Article deleted.");
  });

  t.get("/articles/:id/preview", (req, res) => {
    const tn = res.locals.tenant!;
    const a = repo.article(tn.id, num(req.params.id));
    if (!a) return void res.status(404).send("Not found");
    const theme = a.theme_id ? repo.themeSpec(repo.theme(tn.id, a.theme_id)) : repo.activeTheme(tn);
    res.send(renderArticle(siteInfo(tn, `/s/${tn.slug}`), theme, repo.toView(a), {
      preview: html`<div class="preview-bar">Preview · status: ${a.status} · <a href="${base(res)}/articles/${a.id}">back to editor</a></div>`,
    }));
  });

  // ---- Design -------------------------------------------------------------

  t.get("/design", (req, res) => {
    const tn = res.locals.tenant!;
    const c = ctx(req, res, "design");
    const b = base(res);
    const themes = repo.themes(tn.id);
    const canDesign = can(res.locals.role!, "design.manage");
    const autoApply = tn.settings.ai.themes.autoApply && ROLES.indexOf(res.locals.role!) >= ROLES.indexOf(tn.settings.ai.themes.minRoleToAutoApply);
    res.send(
      adminPage("Design", c, html`<h1>Design</h1>
      ${canDesign && tn.settings.ai.enabled ? html`<form method="post" action="${b}/ai/theme" class="panel ai">${csrfField(c)}
        <h2 style="margin-top:0">✨ Describe the look you want</h2>
        <p class="muted">The AI designs a theme using the shared template system: colors, fonts, layout, hero, header and card styles.</p>
        <textarea name="prompt" required placeholder="e.g. A calm Japanese-inspired look with lots of whitespace, serif headings and a muted green palette. Magazine-style homepage."></textarea>
        <div class="row"><div><label>Start from</label><select name="baseThemeId"><option value="">Current live theme</option>
          ${themes.map((th) => html`<option value="${th.id}">${th.name}</option>`)}</select></div></div>
        <label class="check"><input type="checkbox" name="apply" ${autoApply ? "" : "disabled"}> Apply to the live site immediately
          ${autoApply ? "" : html`<span class="muted">(disabled by site settings — you can apply it manually after reviewing)</span>`}</label>
        <button>Design it</button>
      </form>` : ""}
      <h2>Themes</h2>
      <div class="themes">${themes.map((th) => {
        const spec = repo.themeSpec(th);
        const active = th.id === tn.active_theme_id;
        return html`<div class="panel theme-card ${active ? "active" : ""}">
          <strong>${th.name}</strong> ${active ? html`<span class="badge b-published">live</span>` : ""} ${th.source === "ai" ? html`<span class="badge b-ai">AI</span>` : ""}
          <div class="swatch">${[spec.colors.background, spec.colors.surface, spec.colors.primary, spec.colors.accent, spec.colors.text].map((col) => html`<span style="background:${col}"></span>`)}</div>
          <div class="muted">${spec.typography.headingFont} / ${spec.typography.bodyFont} · ${spec.layout.home} · ${spec.layout.header} header</div>
          ${th.prompt ? html`<p class="muted">“${th.prompt.slice(0, 120)}”</p>` : ""}
          <div class="actions" style="margin-top:.6rem">
            <a class="btn sm sec" href="${b}/design/${th.id}/preview" target="_blank">Preview</a>
            ${canDesign ? html`
              ${active ? "" : html`<form method="post" action="${b}/design/${th.id}/activate" class="inline">${csrfField(c)}<button class="sm">Apply</button></form>`}
              <a class="btn sm sec" href="${b}/design/${th.id}">Edit</a>
              ${active ? "" : html`<form method="post" action="${b}/design/${th.id}/delete" class="inline" onsubmit="return confirm('Delete theme?')">${csrfField(c)}<button class="sm danger">Delete</button></form>`}` : ""}
          </div></div>`;
      })}</div>`),
    );
  });

  t.get("/design/:id/preview", (req, res) => {
    const tn = res.locals.tenant!;
    const row = repo.theme(tn.id, num(req.params.id));
    if (!row) return void res.status(404).send("Not found");
    const articles = repo.articles(tn.id, { status: "published", limit: 12 }).map((a) => repo.toView(a));
    res.send(renderHome(siteInfo(tn, `/s/${tn.slug}`), repo.themeSpec(row), articles, {
      preview: html`<div class="preview-bar">Previewing theme “${row.name}” · <a href="${base(res)}/design">back to Design</a></div>`,
    }));
  });

  t.get("/design/:id", need("design.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const row = repo.theme(tn.id, num(req.params.id));
    if (!row) return void res.status(404).send("Not found");
    const c = ctx(req, res, "design");
    res.send(
      adminPage(`Edit ${row.name}`, c, html`<h1>Edit theme: ${row.name}</h1>
      <form method="post" action="${base(res)}/design/${row.id}" class="panel">${csrfField(c)}
        <p class="muted">Every theme is a JSON spec rendered by the same template engine. Invalid values are clamped or reset to defaults on save.</p>
        <textarea class="big" name="spec">${JSON.stringify(repo.themeSpec(row), null, 2)}</textarea>
        <p class="actions"><button>Save</button> <button class="sec" name="asCopy" value="1">Save as copy</button>
          <a class="btn sec" href="${base(res)}/design/${row.id}/preview" target="_blank">Preview</a></p>
      </form>`),
    );
  });

  t.post("/design/:id", need("design.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const row = repo.theme(tn.id, num(req.params.id));
    if (!row) return void res.status(404).send("Not found");
    let parsed: unknown;
    try {
      parsed = JSON.parse(str(req.body.spec));
    } catch {
      return back(res, `${base(res)}/design/${row.id}`, undefined, "That isn't valid JSON.");
    }
    const spec = normalizeTheme(parsed, repo.themeSpec(row));
    if (str(req.body.asCopy)) {
      const id = repo.createTheme(tn.id, { ...spec, name: `${spec.name} (copy)` }, "manual");
      return back(res, `${base(res)}/design/${id}`, "Saved as a new theme.");
    }
    repo.updateTheme(tn.id, row.id, spec);
    back(res, `${base(res)}/design/${row.id}`, "Theme saved.");
  });

  t.post("/design/:id/activate", need("design.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const row = repo.theme(tn.id, num(req.params.id));
    if (!row) return void res.status(404).send("Not found");
    repo.activateTheme(tn.id, row.id);
    back(res, `${base(res)}/design`, `“${row.name}” is now live.`);
  });

  t.post("/design/:id/delete", need("design.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    if (num(req.params.id) === tn.active_theme_id) return back(res, `${base(res)}/design`, undefined, "Can't delete the live theme.");
    repo.deleteTheme(tn.id, num(req.params.id));
    back(res, `${base(res)}/design`, "Theme deleted.");
  });

  // ---- Settings -----------------------------------------------------------

  t.get("/settings", need("settings.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const c = ctx(req, res, "settings");
    const s = tn.settings.ai;
    const b = base(res);
    const roleSelect = (name: string, value: Role) =>
      html`<select name="${name}">${ROLES.map((r) => html`<option ${r === value ? "selected" : ""}>${r}</option>`)}</select>`;
    const newToken = typeof req.query.token === "string" ? req.query.token : "";
    res.send(
      adminPage("Settings", c, html`<h1>Settings</h1>
      <form method="post" action="${b}/settings">${csrfField(c)}
      <div class="panel"><h2 style="margin-top:0">Site</h2>
        <div class="row"><div><label>Name</label><input name="name" value="${tn.name}" required></div>
        <div><label>Tagline</label><input name="tagline" value="${tn.tagline}"></div>
        <div><label>Custom domain</label><input name="domain" value="${tn.domain ?? ""}" placeholder="blog.example.com"></div></div>
      </div>
      <div class="panel ai"><h2 style="margin-top:0">AI policy</h2>
        <label class="check"><input type="checkbox" name="ai_enabled" ${s.enabled ? "checked" : ""}> Enable AI features</label>
        <div class="row">
          <div><label>Model</label><input name="ai_model" value="${s.model}"></div>
          <div><label>Effort</label><select name="ai_effort">${["low", "medium", "high", "xhigh", "max"].map((e) => html`<option ${e === s.effort ? "selected" : ""}>${e}</option>`)}</select></div>
          <div><label>Who can use AI</label>${roleSelect("ai_minRoleToGenerate", s.minRoleToGenerate)}</div>
        </div>
        <h2>Articles</h2>
        <label class="check"><input type="checkbox" name="ai_autoPublish" ${s.articles.autoPublish ? "checked" : ""}> Allow AI to publish articles directly (no human review)</label>
        <div class="row">
          <div><label>Minimum role to auto-publish</label>${roleSelect("ai_minRoleToAutoPublish", s.articles.minRoleToAutoPublish)}</div>
          <div><label>Monthly AI article limit (0 = unlimited)</label><input type="number" min="0" name="ai_monthlyLimit" value="${s.articles.monthlyLimit}"></div>
          <div><label>Language</label><input name="ai_language" value="${s.articles.language}"></div>
          <div><label>Default tone</label><input name="ai_tone" value="${s.articles.defaultTone}"></div>
          <div><label>Default length</label><select name="ai_length">${["short", "medium", "long"].map((l) => html`<option ${l === s.articles.defaultLength ? "selected" : ""}>${l}</option>`)}</select></div>
        </div>
        <label>Brand voice & editorial guidelines (given to the AI on every article)</label>
        <textarea name="ai_brandVoice" placeholder="Audience, style rules, words to avoid, house style…">${s.articles.brandVoice}</textarea>
        <h2>Design</h2>
        <label class="check"><input type="checkbox" name="ai_autoApply" ${s.themes.autoApply ? "checked" : ""}> Allow AI-designed themes to be applied to the live site immediately</label>
        <div class="row"><div><label>Minimum role to auto-apply</label>${roleSelect("ai_minRoleToAutoApply", s.themes.minRoleToAutoApply)}</div></div>
      </div>
      <p><button>Save settings</button></p>
      </form>

      <div class="panel"><h2 style="margin-top:0">Members</h2>
        <table><tr><th>Email</th><th>Name</th><th>Role</th><th></th></tr>
        ${repo.members(tn.id).map((m) => html`<tr><td>${m.email}</td><td>${m.name}</td><td>${m.role}</td><td>
          ${m.id === res.locals.user!.id ? "" : html`<form method="post" action="${b}/members/${m.id}/remove" class="inline">${csrfField(c)}<button class="sm danger">Remove</button></form>`}</td></tr>`)}
        </table>
        <form method="post" action="${b}/members" class="row" style="align-items:end">${csrfField(c)}
          <div><label>Email</label><input type="email" name="email" required></div>
          <div><label>Role</label>${roleSelect("role", "author")}</div>
          <div><button>Add / update member</button></div>
        </form>
      </div>

      <div class="panel"><h2 style="margin-top:0">API tokens</h2>
        <p class="muted">Use with <code>Authorization: Bearer &lt;token&gt;</code> on <code>/api/v1</code>. A token acts with the role you choose.</p>
        ${newToken ? html`<div class="flash">New token (copy it now, it won't be shown again): <code>${newToken}</code></div>` : ""}
        <table><tr><th>Name</th><th>Role</th><th>Created</th><th></th></tr>
        ${repo.apiTokens(tn.id).map((k) => html`<tr><td>${k.name}</td><td>${k.role}</td><td>${k.created_at}</td><td>
          <form method="post" action="${b}/tokens/${k.id}/delete" class="inline">${csrfField(c)}<button class="sm danger">Revoke</button></form></td></tr>`)}
        </table>
        <form method="post" action="${b}/tokens" class="row" style="align-items:end">${csrfField(c)}
          <div><label>Name</label><input name="name" required placeholder="n8n / Zapier / script"></div>
          <div><label>Role</label>${roleSelect("role", "author")}</div>
          <div><button>Create token</button></div>
        </form>
      </div>`),
    );
  });

  t.post("/settings", need("settings.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const b = req.body;
    const parsed = TenantSettingsSchema.safeParse({
      ai: {
        enabled: bool(b.ai_enabled),
        model: str(b.ai_model).trim() || undefined,
        effort: str(b.ai_effort),
        minRoleToGenerate: str(b.ai_minRoleToGenerate),
        articles: {
          autoPublish: bool(b.ai_autoPublish),
          minRoleToAutoPublish: str(b.ai_minRoleToAutoPublish),
          monthlyLimit: Math.max(0, Math.floor(num(b.ai_monthlyLimit) || 0)),
          language: str(b.ai_language) || undefined,
          defaultTone: str(b.ai_tone) || undefined,
          defaultLength: str(b.ai_length),
          brandVoice: str(b.ai_brandVoice),
        },
        themes: { autoApply: bool(b.ai_autoApply), minRoleToAutoApply: str(b.ai_minRoleToAutoApply) },
      },
    });
    if (!parsed.success) return back(res, `${base(res)}/settings`, undefined, "Invalid settings: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
    const domain = str(b.domain).trim().toLowerCase() || null;
    if (domain) {
      const other = repo.tenantByDomain(domain);
      if (other && other.id !== tn.id) return back(res, `${base(res)}/settings`, undefined, "That domain is used by another site.");
    }
    repo.updateTenant(tn.id, { name: str(b.name) || tn.name, tagline: str(b.tagline), domain, settings: parsed.data });
    back(res, `${base(res)}/settings`, "Settings saved.");
  });

  t.post("/members", need("members.manage"), (req, res) => {
    const tn = res.locals.tenant!;
    const email = str(req.body.email).trim().toLowerCase();
    const role = (ROLES as readonly string[]).includes(str(req.body.role)) ? (str(req.body.role) as Role) : "author";
    let user = repo.userByEmail(email);
    let msg = `${email} is now ${role}.`;
    if (!user) {
      const temp = crypto.randomBytes(9).toString("base64url");
      repo.createUser(email, email.split("@")[0], hashPassword(temp));
      user = repo.userByEmail(email)!;
      msg += ` New account created with temporary password: ${temp}`;
    }
    repo.setMembership(user.id, tn.id, role);
    back(res, `${base(res)}/settings`, msg);
  });

  t.post("/members/:uid/remove", need("members.manage"), (req, res) => {
    if (num(req.params.uid) === res.locals.user!.id) return back(res, `${base(res)}/settings`, undefined, "You can't remove yourself.");
    repo.removeMembership(num(req.params.uid), res.locals.tenant!.id);
    back(res, `${base(res)}/settings`, "Member removed.");
  });

  t.post("/tokens", need("settings.manage"), (req, res) => {
    const role = (ROLES as readonly string[]).includes(str(req.body.role)) ? (str(req.body.role) as Role) : "author";
    const token = repo.createApiToken(res.locals.tenant!.id, str(req.body.name) || "token", role);
    res.redirect(303, `${base(res)}/settings?${new URLSearchParams({ token, msg: "Token created." })}`);
  });

  t.post("/tokens/:id/delete", need("settings.manage"), (req, res) => {
    repo.deleteApiToken(res.locals.tenant!.id, num(req.params.id));
    back(res, `${base(res)}/settings`, "Token revoked.");
  });

  return r;
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function errMsg(e: unknown) {
  if (e instanceof PolicyError) return e.message;
  if (e && typeof e === "object" && "issues" in e) return "Please check the form: " + (e as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ");
  return e instanceof Error ? e.message : String(e);
}

function aiArticleForm(c: AdminCtx, b: string, settings: TenantSettings, canAutoPublish: boolean, provider: string) {
  const s = settings.ai.articles;
  return html`<form method="post" action="${b}/ai/article" class="panel ai">${csrfField(c)}
    <h2 style="margin-top:0">✨ Ask the AI to write an article</h2>
    <label>What should it be about?</label>
    <input name="topic" required placeholder="e.g. How small cafés can use loyalty programs without an app">
    <label>Extra instructions (optional)</label>
    <textarea name="instructions" style="min-height:4rem" placeholder="Angle, audience, key points, links to include…"></textarea>
    <div class="row">
      <div><label>Tone</label><input name="tone" placeholder="${s.defaultTone}"></div>
      <div><label>Length</label><select name="length">${["short", "medium", "long"].map((l) => html`<option ${l === s.defaultLength ? "selected" : ""}>${l}</option>`)}</select></div>
    </div>
    <label class="check"><input type="checkbox" name="publish" checked> Publish when done
      <span class="muted">${canAutoPublish ? "(allowed by site settings)" : "(site settings require review — it will go to the review queue)"}</span></label>
    <label class="check"><input type="checkbox" name="designLook" onchange="document.getElementById('brief').style.display=this.checked?'block':'none'"> Also design a custom look for this article</label>
    <div id="brief" style="display:none"><input name="designBrief" placeholder="Optional design brief, e.g. warm, rustic, handwritten feel"></div>
    <p><button>Write it</button> ${provider === "mock" ? html`<span class="muted">Running in <strong>mock AI</strong> mode — set <code>ANTHROPIC_API_KEY</code> for real articles.</span>` : ""}</p>
  </form>`;
}

function articleTable(b: string, rows: ArticleRow[]) {
  if (!rows.length) return html`<div class="panel muted">No articles yet.</div>`;
  return html`<table><tr><th>Title</th><th>Status</th><th>Source</th><th>Updated</th><th></th></tr>
    ${rows.map((a) => html`<tr>
      <td><a href="${b}/articles/${a.id}">${a.title}</a></td><td>${statusBadge(a.status)}</td>
      <td>${a.source === "ai" ? html`<span class="badge b-ai">AI</span>` : "human"}</td><td class="muted">${a.updated_at}</td>
      <td><a href="${b}/articles/${a.id}/preview" target="_blank">Preview</a></td></tr>`)}
  </table>`;
}

function jobsTable(b: string, jobs: ReturnType<Repo["jobs"]>) {
  if (!jobs.length) return html`<div class="panel muted">No AI jobs yet.</div>`;
  return html`<table><tr><th>#</th><th>Kind</th><th>Request</th><th>Status</th><th>When</th></tr>
    ${jobs.map((j) => {
      const input = safeJson<Record<string, unknown>>(j.input, {});
      return html`<tr><td><a href="${b}/jobs/${j.id}">${j.id}</a></td><td>${j.kind}</td>
        <td>${String(input.topic ?? input.prompt ?? "").slice(0, 80)}</td><td>${statusBadge(j.status)}${j.error ? html` <span class="muted">${j.error.slice(0, 80)}</span>` : ""}</td>
        <td class="muted">${j.created_at}</td></tr>`;
    })}</table>`;
}

function readArticleForm(req: Request, role: Role) {
  const b = req.body;
  let status = str(b.status) as ArticleRow["status"];
  if (!["draft", "review", "published"].includes(status)) status = "draft";
  if (status === "published" && !can(role, "article.publish")) status = "review";
  return {
    title: str(b.title).trim() || "Untitled",
    slug: str(b.slug).trim(),
    summary: str(b.summary),
    seoDescription: str(b.seoDescription),
    blocks: markdownToBlocks(str(b.body)),
    tags: str(b.tags).split(","),
    status,
    themeId: num(b.themeId) || null,
  };
}

function articleForm(c: AdminCtx, b: string, role: Role, repo: Repo, tenantId: number, a?: ArticleRow, editable = true) {
  const view = a ? repo.toView(a) : undefined;
  const themes = repo.themes(tenantId);
  const statuses = can(role, "article.publish") ? ["draft", "review", "published"] : ["draft", "review"];
  return html`<h1>${a ? "Edit article" : "New article"} ${a ? statusBadge(a.status) : ""} ${a?.source === "ai" ? html`<span class="badge b-ai">AI</span>` : ""}</h1>
  ${a?.ai_prompt ? html`<div class="panel muted"><strong>AI prompt:</strong> ${a.ai_prompt}</div>` : ""}
  ${a && a.status !== "published" && can(role, "article.publish")
    ? html`<form method="post" action="${b}/articles/${a.id}/status" class="panel">${csrfField(c)}<input type="hidden" name="status" value="published">
      ${a.status === "review" ? "This article is waiting for review. " : ""}<button>Approve & publish</button></form>`
    : ""}
  <form method="post" action="${a ? `${b}/articles/${a.id}` : `${b}/articles`}" class="panel">${csrfField(c)}
    <fieldset ${editable ? "" : "disabled"} style="border:0;padding:0;margin:0">
    <label>Title</label><input name="title" value="${a?.title ?? ""}" required>
    <div class="row"><div><label>Slug</label><input name="slug" value="${a?.slug ?? ""}" placeholder="auto from title"></div>
      <div><label>Tags (comma separated)</label><input name="tags" value="${view?.tags.join(", ") ?? ""}"></div>
      <div><label>Status</label><select name="status">${statuses.map((s) => html`<option ${s === (a?.status ?? "draft") ? "selected" : ""}>${s}</option>`)}</select></div>
      <div><label>Look</label><select name="themeId"><option value="">Site theme</option>${themes.map((th) => html`<option value="${th.id}" ${th.id === a?.theme_id ? "selected" : ""}>${th.name}</option>`)}</select></div>
    </div>
    <label>Summary</label><input name="summary" value="${a?.summary ?? ""}">
    <label>SEO description</label><input name="seoDescription" value="${a?.seo_description ?? ""}">
    <label>Body <span class="muted">(Markdown: ## headings, lists, &gt; quotes, &gt; [!TIP] callouts, \`\`\`code\`\`\`, ![alt](https://image))</span></label>
    <textarea class="big" name="body">${view ? blocksToMarkdown(view.blocks) : ""}</textarea>
    <p class="actions"><button>Save</button>
      ${a ? html`<a class="btn sec" href="${b}/articles/${a.id}/preview" target="_blank">Preview</a>` : ""}</p>
    </fieldset>
    ${editable ? "" : html`<p class="muted">You can't edit this article with your role.</p>`}
  </form>
  ${a && can(role, "article.delete") ? html`<form method="post" action="${b}/articles/${a.id}/delete" onsubmit="return confirm('Delete this article?')">${csrfField(c)}<button class="danger sm">Delete article</button></form>` : ""}`;
}

