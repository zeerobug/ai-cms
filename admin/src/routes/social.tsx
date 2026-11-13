import { useEffect, useState, type FormEvent } from "react";
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { SocialData, SocialInput, SocialNetwork, SocialShareInput } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { checked, field, StatusBadge, useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<SocialData>(`${tapi(params.tenant!)}/social`, request);

export function Component() {
  const d = useLoaderData() as SocialData;
  const tenant = useTenant();
  const { revalidate, state } = useRevalidator();

  // While a post is going out, refresh every few seconds to show its outcome.
  useEffect(() => {
    if (!d.busy) return;
    const timer = setInterval(() => state === "idle" && revalidate(), 3000);
    return () => clearInterval(timer);
  }, [d.busy, state, revalidate]);

  return (
    <div key={tenant.slug}>
      <h1>Social</h1>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          Share your published articles on LinkedIn, X and Facebook, automatically when an article goes live or on demand.
          Each post links back to the article.
        </p>
        {d.effectiveSiteUrl ? (
          <p className="muted">Articles are linked under <code>{d.effectiveSiteUrl}</code>.</p>
        ) : (
          <p className="muted">⚠️ This site has no public address yet: set the <strong>Site URL</strong> below, add a custom domain, or set up static publishing.</p>
        )}
        <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
          {d.networks.map((n) => (
            <li key={n.network}>
              <strong>{n.label}</strong>: {!n.enabled ? <span className="muted">off</span> : n.gap ? <span className="muted">{n.gap}</span> : "ready"}
            </li>
          ))}
        </ul>
      </div>
      <ShareForm d={d} />
      {d.canConfigure && <SocialForm d={d} />}
      <h2>Recent posts</h2>
      {d.posts.length === 0 ? (
        <div className="panel muted">Nothing shared yet.</div>
      ) : (
        <table>
          <thead><tr><th>Article</th><th>Network</th><th>Status</th><th>How</th><th>When</th></tr></thead>
          <tbody>
            {d.posts.map((p) => (
              <tr key={p.id}>
                <td>{p.articleTitle}</td>
                <td>{d.networks.find((n) => n.network === p.network)?.label}</td>
                <td>
                  <StatusBadge status={p.status} />
                  {p.error && <span className="muted"> {p.error}</span>}
                  {p.status === "posted" && p.url && <> <a href={p.url} target="_blank" rel="noreferrer">view ↗</a></>}
                </td>
                <td className="muted">{p.trigger}</td>
                <td className="muted">{p.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "Share now": pick a published article and the networks to post it to. */
function ShareForm({ d }: { d: SocialData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const ready = d.networks.filter((n) => !n.gap);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body: SocialShareInput = {
      articleId: Number(field(fd, "articleId")),
      networks: ready.filter((n) => checked(fd, `n-${n.network}`)).map((n) => n.network),
      text: field(fd, "text").trim() || undefined,
    };
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/social/post`, { body });
      await revalidate();
      notify(message);
    });
  };
  return (
    <form onSubmit={submit} className="panel">
      <h2 style={{ marginTop: 0 }}>Share an article now</h2>
      {ready.length === 0 ? (
        <p className="muted">Set up at least one network below first.</p>
      ) : d.articles.length === 0 ? (
        <p className="muted">There are no published articles yet.</p>
      ) : (
        <>
          <label>Article</label>
          <select name="articleId">{d.articles.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select>
          <label>Text <span className="muted">(optional: replaces the default of title + summary + hashtags)</span></label>
          <textarea name="text" rows={3} maxLength={3000} />
          <p>
            {ready.map((n) => (
              <label key={n.network} className="check" style={{ display: "inline-block", marginRight: 16 }}>
                <input type="checkbox" name={`n-${n.network}`} defaultChecked={n.enabled} /> {n.label}
              </label>
            ))}
          </p>
          <p><button disabled={busy}>Post now</button></p>
        </>
      )}
    </form>
  );
}

const HELP: Record<SocialNetwork, string> = {
  linkedin: "A member access token with the w_member_social scope (or w_organization_social for a company page), from your LinkedIn developer app. LinkedIn tokens expire after about 60 days.",
  x: "From your app in the X developer portal: API key and secret, plus an access token and secret with Read and Write permission. These don't expire.",
  facebook: "A Page access token (pages_manage_posts) for the Page below. A long-lived Page token doesn't expire.",
};

function SocialForm({ d }: { d: SocialData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const [auto, setAuto] = useState(d.auto);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body: SocialInput = {
      networks: d.networks.filter((n) => checked(fd, `on-${n.network}`)).map((n) => n.network),
      auto: checked(fd, "auto"),
      siteUrl: field(fd, "siteUrl").trim(),
      linkedinAuthor: field(fd, "linkedinAuthor").trim(),
      facebookPageId: field(fd, "facebookPageId").trim(),
      creds: Object.fromEntries(d.networks.map((n) => [n.network, Object.fromEntries(n.fields.map((f) => [f.key, field(fd, `${n.network}.${f.key}`)]))])),
      clear: d.networks.filter((n) => checked(fd, `clear-${n.network}`)).map((n) => n.network),
    };
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/social`, { method: "PUT", body });
      for (const el of Array.from(form.elements)) if (el instanceof HTMLInputElement && el.type === "password") el.value = "";
      await revalidate();
      notify(message);
    });
  };
  return (
    <form onSubmit={submit} className="panel" key={JSON.stringify([d.networks.map((n) => n.enabled), d.auto])}>
      <h2 style={{ marginTop: 0 }}>Networks</h2>
      {d.unreadable && <div className="flash warn">The stored credentials can't be read (APP_SECRET changed?). Enter them again.</div>}
      <label>Site URL <span className="muted">(optional: where article links point; defaults to the static site, custom domain or subdomain)</span></label>
      <input name="siteUrl" defaultValue={d.siteUrl} placeholder="https://blog.example.com" />
      {d.networks.map((n) => (
        <fieldset key={n.network} style={{ marginTop: 16 }}>
          <legend><label className="check"><input type="checkbox" name={`on-${n.network}`} defaultChecked={n.enabled} /> <strong>{n.label}</strong></label></legend>
          <p className="muted" style={{ marginTop: 0 }}>{HELP[n.network]}</p>
          {n.network === "linkedin" && (
            <>
              <label>Author <span className="muted">(urn:li:person:… or urn:li:organization:…)</span></label>
              <input name="linkedinAuthor" defaultValue={d.linkedinAuthor} placeholder="urn:li:person:AbCdEf123" />
            </>
          )}
          {n.network === "facebook" && (
            <>
              <label>Page ID</label>
              <input name="facebookPageId" defaultValue={d.facebookPageId} inputMode="numeric" placeholder="1234567890" />
            </>
          )}
          <div className="row">
            {n.fields.map((f) => (
              <div key={f.key}>
                <label>{f.label} {f.stored ? <span className="muted">(stored)</span> : <span className="muted">(none)</span>}</label>
                <input type="password" name={`${n.network}.${f.key}`} autoComplete="off" placeholder={f.stored ? "Leave empty to keep" : ""} />
              </div>
            ))}
          </div>
          {n.fields.some((f) => f.stored) && <label className="check"><input type="checkbox" name={`clear-${n.network}`} /> Remove the stored credentials</label>}
        </fieldset>
      ))}
      <label className="check" style={{ marginTop: 16 }}>
        <input type="checkbox" name="auto" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Post automatically when an article is published
      </label>
      <p className="muted">
        Automatic posts go to every network that is switched on and ready, for articles published after you turn this on (older articles are never posted).
        If a post fails it isn't retried automatically; share it again from above. Credentials are stored encrypted and never shown again.
      </p>
      <p><button disabled={busy}>Save social settings</button></p>
    </form>
  );
}
