import { html, raw, type Raw } from "../util/html.js";
import type { Tenant } from "../repo.js";
import type { Role } from "../tenancy.js";

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;color:#1c1d21}
a{color:#3b5bdb}header.top{background:#15161a;color:#fff;padding:.7rem 1.5rem;display:flex;gap:1.2rem;align-items:center;flex-wrap:wrap}
header.top a{color:#d0d4dd;text-decoration:none}header.top a.on,header.top a:hover{color:#fff}
header.top .logo{font-weight:800;color:#fff;margin-right:1rem}header.top .sp{flex:1}
main{max-width:1100px;margin:1.5rem auto;padding:0 1.25rem}
h1{font-size:1.5rem;margin:.2rem 0 1rem}h2{font-size:1.1rem;margin:1.6rem 0 .6rem}
.panel{background:#fff;border:1px solid #e3e5ea;border-radius:10px;padding:1.2rem;margin-bottom:1.2rem}
.ai{background:linear-gradient(135deg,#eef2ff,#fdf4ff);border-color:#d9dcfb}
label{display:block;font-weight:600;font-size:.85rem;margin:.7rem 0 .25rem}
input[type=text],input[type=email],input[type=password],input[type=number],input:not([type]),select,textarea{width:100%;padding:.55rem .65rem;border:1px solid #cfd3db;border-radius:7px;font:inherit;background:#fff}
textarea{min-height:6rem;font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
textarea.big{min-height:28rem}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.8rem}
.check{display:flex;gap:.5rem;align-items:center;font-weight:500;margin:.6rem 0}
.check input{width:auto}
button,.btn{display:inline-block;background:#3b5bdb;color:#fff;border:0;border-radius:7px;padding:.55rem 1rem;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.sec,button.sec{background:#e9ecf3;color:#1c1d21}.btn.danger,button.danger{background:#e03131}
.btn.sm,button.sm{padding:.3rem .65rem;font-size:.82rem}
table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:.55rem .6rem;border-bottom:1px solid #eceef2;text-align:left;font-size:.9rem;vertical-align:middle}
th{font-size:.75rem;text-transform:uppercase;color:#6b7080;letter-spacing:.04em}
.badge{display:inline-block;font-size:.72rem;padding:.1rem .5rem;border-radius:99px;background:#e9ecf3;font-weight:600}
.b-published,.b-succeeded{background:#d3f9d8;color:#2b8a3e}.b-review,.b-running,.b-queued{background:#fff3bf;color:#a06000}
.b-draft{background:#e9ecf3}.b-failed{background:#ffe3e3;color:#c92a2a}.b-ai{background:#f3d9fa;color:#862e9c}
.flash{background:#e7f5ff;border:1px solid #a5d8ff;padding:.7rem 1rem;border-radius:8px;margin-bottom:1rem}
.err{background:#fff5f5;border-color:#ffc9c9}
.muted{color:#6b7080;font-size:.85rem}.inline{display:inline}
.themes{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1rem}
.swatch{display:flex;height:36px;border-radius:6px;overflow:hidden;margin:.5rem 0}.swatch span{flex:1}
.theme-card.active{outline:3px solid #3b5bdb}
.actions{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.spinner{width:22px;height:22px;border:3px solid #ccd;border-top-color:#3b5bdb;border-radius:50%;animation:s 1s linear infinite;display:inline-block;vertical-align:middle}
@keyframes s{to{transform:rotate(360deg)}}
code{background:#eef0f4;padding:.05rem .3rem;border-radius:4px;font-size:.85em}
`;

export interface AdminCtx {
  csrf?: string;
  userEmail?: string;
  tenant?: Tenant;
  role?: Role;
  section?: "dashboard" | "articles" | "design" | "settings";
  flash?: string;
  error?: string;
}

export function csrfField(ctx: AdminCtx): Raw {
  return ctx.csrf ? html`<input type="hidden" name="_csrf" value="${ctx.csrf}">` : raw("");
}

export function adminPage(title: string, ctx: AdminCtx, body: Raw): string {
  const t = ctx.tenant;
  const nav = t
    ? html`
        <a href="/admin/${t.slug}" class="${ctx.section === "dashboard" ? "on" : ""}">Dashboard</a>
        <a href="/admin/${t.slug}/articles" class="${ctx.section === "articles" ? "on" : ""}">Articles</a>
        <a href="/admin/${t.slug}/design" class="${ctx.section === "design" ? "on" : ""}">Design</a>
        ${ctx.role === "owner" ? html`<a href="/admin/${t.slug}/settings" class="${ctx.section === "settings" ? "on" : ""}">Settings</a>` : ""}
        <a href="/s/${t.slug}" target="_blank">View site ↗</a>`
    : "";
  return `<!doctype html>${html`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AICMS</title><style>${raw(CSS)}</style></head><body>
<header class="top">
  <a class="logo" href="/admin">AICMS</a>
  ${t ? html`<strong>${t.name}</strong>` : ""}
  ${nav}
  <span class="sp"></span>
  ${ctx.userEmail
    ? html`<span class="muted" style="color:#9aa">${ctx.userEmail}${ctx.role ? ` · ${ctx.role}` : ""}</span>
      <form method="post" action="/admin/logout" class="inline">${csrfField(ctx)}<button class="sm sec">Log out</button></form>`
    : ""}
</header>
<main>
${ctx.flash ? html`<div class="flash">${ctx.flash}</div>` : ""}
${ctx.error ? html`<div class="flash err">${ctx.error}</div>` : ""}
${body}
</main></body></html>`}`;
}

export const statusBadge = (s: string) => html`<span class="badge b-${s}">${s}</span>`;
