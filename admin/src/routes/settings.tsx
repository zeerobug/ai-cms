import { useState, type FormEvent } from "react";
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { AiSettings, ArticleLength, Effort, Role, SettingsData, SettingsInput } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { checked, field, RoleSelect, useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<SettingsData>(`${tapi(params.tenant!)}/settings`, request);

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const LENGTHS: ArticleLength[] = ["short", "medium", "long"];

export function Component() {
  const s = useLoaderData() as SettingsData;
  const { slug } = useTenant();
  // The forms use uncontrolled inputs (defaultValue); key by site so switching
  // sites remounts them instead of keeping the previous site's values.
  return (
    <div key={slug}>
      <h1>Settings</h1>
      <SettingsForm s={s} />
      <Members s={s} />
      <Tokens s={s} />
    </div>
  );
}

function SettingsForm({ s }: { s: SettingsData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const ai = s.ai;
  const key = s.apiKey;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const aiOut: AiSettings = {
      enabled: checked(fd, "enabled"),
      provider: field(fd, "provider"),
      model: field(fd, "model").trim() || ai.model,
      effort: field(fd, "effort") as Effort,
      minRoleToGenerate: field(fd, "minRoleToGenerate") as Role,
      articles: {
        autoPublish: checked(fd, "autoPublish"),
        minRoleToAutoPublish: field(fd, "minRoleToAutoPublish") as Role,
        monthlyLimit: Math.max(0, Math.floor(Number(field(fd, "monthlyLimit")) || 0)),
        language: field(fd, "language") || ai.articles.language,
        defaultTone: field(fd, "defaultTone") || ai.articles.defaultTone,
        defaultLength: field(fd, "defaultLength") as ArticleLength,
        brandVoice: field(fd, "brandVoice"),
      },
      themes: { autoApply: checked(fd, "autoApply"), minRoleToAutoApply: field(fd, "minRoleToAutoApply") as Role },
      images: { monthlyLimit: Math.max(0, Math.floor(Number(field(fd, "imageMonthlyLimit")) || 0)) },
    };
    const body: SettingsInput = {
      name: field(fd, "name"),
      tagline: field(fd, "tagline"),
      domain: field(fd, "domain") || null,
      ai: aiOut,
      apiKey: field(fd, "apiKey"),
      clearKey: checked(fd, "clearKey"),
    };
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/settings`, { method: "PUT", body });
      (form.elements.namedItem("apiKey") as HTMLInputElement).value = "";
      await revalidate(); // refreshes this page and the tenant layout (name, AI policy)
      notify(message);
    });
  };

  return (
    <form onSubmit={submit}>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Site</h2>
        <div className="row">
          <div><label>Name</label><input name="name" defaultValue={s.name} required /></div>
          <div><label>Tagline</label><input name="tagline" defaultValue={s.tagline} /></div>
          <div><label>Custom domain</label><input name="domain" defaultValue={s.domain ?? ""} placeholder="blog.example.com" /></div>
        </div>
      </div>
      <div className="panel ai">
        <h2 style={{ marginTop: 0 }}>AI policy</h2>
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={ai.enabled} /> Enable AI features</label>

        <h2>LLM provider</h2>
        <div className="row">
          <div>
            <label>Provider</label>
            <select name="provider" defaultValue={ai.provider}>
              {s.providers.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label>
              API key{" "}
              {!key.stored ? (
                <span className="muted">(none — using platform key)</span>
              ) : key.unreadable ? (
                <span className="badge">unreadable — re-enter it</span>
              ) : (
                <span className="muted">(stored: <code>{key.masked}</code>)</span>
              )}
            </label>
            <input type="password" name="apiKey" autoComplete="off" placeholder={key.stored ? "Leave empty to keep the current key" : "Leave empty to use the platform key"} />
          </div>
        </div>
        {key.stored && <label className="check"><input type="checkbox" name="clearKey" /> Remove this site's API key (fall back to the platform key)</label>}
        <p className="muted">With "Platform default", the site uses the server's provider and key. With a specific provider, the site's own key is used if set, otherwise the platform key. Keys are stored encrypted and never shown again.</p>

        <h2>Generation</h2>
        <div className="row">
          <div><label>Model</label><input name="model" defaultValue={ai.model} title="e.g. claude-opus-5-5 for Anthropic, gpt-5.5 for OpenAI. A model from another provider is replaced by that provider's default." /></div>
          <div><label>Effort</label><select name="effort" defaultValue={ai.effort}>{EFFORTS.map((e) => <option key={e}>{e}</option>)}</select></div>
          <div><label>Who can use AI</label><RoleSelect name="minRoleToGenerate" defaultValue={ai.minRoleToGenerate} /></div>
        </div>

        <h2>Articles</h2>
        <label className="check"><input type="checkbox" name="autoPublish" defaultChecked={ai.articles.autoPublish} /> Allow AI to publish articles directly (no human review)</label>
        <div className="row">
          <div><label>Minimum role to auto-publish</label><RoleSelect name="minRoleToAutoPublish" defaultValue={ai.articles.minRoleToAutoPublish} /></div>
          <div><label>Monthly AI article limit (0 = unlimited)</label><input type="number" min={0} name="monthlyLimit" defaultValue={ai.articles.monthlyLimit} /></div>
          <div><label>Language</label><input name="language" defaultValue={ai.articles.language} /></div>
          <div><label>Default tone</label><input name="defaultTone" defaultValue={ai.articles.defaultTone} /></div>
          <div><label>Default length</label><select name="defaultLength" defaultValue={ai.articles.defaultLength}>{LENGTHS.map((l) => <option key={l}>{l}</option>)}</select></div>
        </div>
        <label>Brand voice & editorial guidelines (given to the AI on every article)</label>
        <textarea name="brandVoice" defaultValue={ai.articles.brandVoice} placeholder="Audience, style rules, words to avoid, house style…" />

        <h2>Design</h2>
        <label className="check"><input type="checkbox" name="autoApply" defaultChecked={ai.themes.autoApply} /> Allow AI-designed themes to be applied to the live site immediately</label>
        <div className="row"><div><label>Minimum role to auto-apply</label><RoleSelect name="minRoleToAutoApply" defaultValue={ai.themes.minRoleToAutoApply} /></div></div>

        <h2>Images</h2>
        <div className="row"><div><label>Monthly AI image limit (0 = unlimited)</label><input type="number" min={0} name="imageMonthlyLimit" defaultValue={ai.images.monthlyLimit} /></div></div>
        <p className="muted">
          Claude only writes text, so AI images come from OpenAI: the site's OpenAI provider, or the platform's OpenAI key when the site uses Claude.
          {tenant.ai.imageProvider ? <> This site generates images with <strong>{tenant.ai.imageProvider}</strong>.</> : " AI images aren't available for this site right now; uploads always work."}
        </p>
      </div>
      <p><button disabled={busy}>Save settings</button></p>
    </form>
  );
}

function Members({ s }: { s: SettingsData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const t = tapi(tenant.slug);
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    run(async () => {
      const { message } = await api<{ message: string }>(`${t}/members`, { body: { email: field(fd, "email"), role: field(fd, "role") } });
      form.reset();
      await revalidate();
      notify(message);
    });
  };
  const remove = (id: number) =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${t}/members/${id}`, { method: "DELETE" });
      await revalidate();
      notify(message);
    });
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Members</h2>
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th></th></tr></thead>
        <tbody>
          {s.members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}</td><td>{m.name}</td><td>{m.role}</td>
              <td>{m.id !== s.currentUserId && <button className="sm danger" onClick={() => remove(m.id)} disabled={busy}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="row" style={{ alignItems: "end" }}>
        <div><label>Email</label><input type="email" name="email" required /></div>
        <div><label>Role</label><RoleSelect name="role" defaultValue="author" /></div>
        <div><button disabled={busy}>Add / update member</button></div>
      </form>
    </div>
  );
}

function Tokens({ s }: { s: SettingsData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const [newToken, setNewToken] = useState("");
  const t = tapi(tenant.slug);
  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    run(async () => {
      const { token } = await api<{ token: string }>(`${t}/tokens`, { body: { name: field(fd, "name"), role: field(fd, "role") } });
      form.reset();
      await revalidate();
      setNewToken(token);
      notify("Token created.");
    });
  };
  const revoke = (id: number) =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${t}/tokens/${id}`, { method: "DELETE" });
      await revalidate();
      notify(message);
    });
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>API tokens</h2>
      <p className="muted">Use with <code>Authorization: Bearer &lt;token&gt;</code> on <code>/api/v1</code>. A token acts with the role you choose.</p>
      {newToken && <div className="flash">New token (copy it now, it won't be shown again): <code>{newToken}</code></div>}
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {s.tokens.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td><td>{k.role}</td><td>{k.created_at}</td>
              <td><button className="sm danger" onClick={() => revoke(k.id)} disabled={busy}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} className="row" style={{ alignItems: "end" }}>
        <div><label>Name</label><input name="name" required placeholder="n8n / Zapier / script" /></div>
        <div><label>Role</label><RoleSelect name="role" defaultValue="author" /></div>
        <div><button disabled={busy}>Create token</button></div>
      </form>
    </div>
  );
}
