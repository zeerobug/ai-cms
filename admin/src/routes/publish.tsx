import { useEffect, type FormEvent } from "react";
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { PublishData, PublishInput } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { checked, field, StatusBadge, useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<PublishData>(`${tapi(params.tenant!)}/publish`, request);

export function Component() {
  const p = useLoaderData() as PublishData;
  const tenant = useTenant();
  const { revalidate, state } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();

  // While a deploy is scheduled or running, refresh every few seconds to show its outcome.
  useEffect(() => {
    if (!p.busy) return;
    const timer = setInterval(() => state === "idle" && revalidate(), 3000);
    return () => clearInterval(timer);
  }, [p.busy, state, revalidate]);

  const deployNow = () =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/publish/deploy`, { body: {} });
      await revalidate();
      notify(message);
    });

  return (
    <div key={tenant.slug}>
      <h1>Static publishing</h1>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          Exports the public site (home, articles, tag pages, RSS, sitemap, robots.txt and the images they use) as static files and deploys them to{" "}
          <a href="https://www.netlify.com/" target="_blank" rel="noreferrer">Netlify</a>. Netlify serves them from its CDN, with your custom domain and HTTPS.
        </p>
        {p.siteUrl && (
          <p>Live static site: <a href={p.siteUrl} target="_blank" rel="noreferrer">{p.siteUrl}</a></p>
        )}
        {p.ready ? (
          <p>
            <button onClick={deployNow} disabled={busy}>🚀 Deploy now</button>{" "}
            {p.busy && <span className="muted"><span className="spinner" /> deploying…</span>}
            {!p.busy && <span className="muted">{p.auto ? "Changes are deployed automatically a few seconds after they're saved." : "Automatic deploys are off."}</span>}
          </p>
        ) : (
          <p className="muted">{p.reason}</p>
        )}
      </div>
      {p.canConfigure && <PublishForm p={p} />}
      <h2>Recent deploys</h2>
      {p.deploys.length === 0 ? (
        <div className="panel muted">No deploys yet.</div>
      ) : (
        <table>
          <thead><tr><th>#</th><th>Trigger</th><th>Status</th><th>Files</th><th>Started</th><th>Finished</th></tr></thead>
          <tbody>
            {p.deploys.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td>
                <td>{d.trigger}</td>
                <td>
                  <StatusBadge status={d.status} />
                  {d.error && <span className="muted"> {d.error}</span>}
                  {d.status === "succeeded" && d.url && <> <a href={d.url} target="_blank" rel="noreferrer">view ↗</a></>}
                </td>
                <td className="muted">{d.files ? `${d.files} (${d.uploaded} uploaded)` : ""}</td>
                <td className="muted">{d.createdAt}</td>
                <td className="muted">{d.finishedAt ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PublishForm({ p }: { p: PublishData }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body: PublishInput = {
      netlifySiteId: field(fd, "netlifySiteId").trim(),
      auto: checked(fd, "auto"),
      token: field(fd, "token"),
      clearToken: checked(fd, "clearToken"),
    };
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/publish`, { method: "PUT", body });
      (form.elements.namedItem("token") as HTMLInputElement).value = "";
      await revalidate();
      notify(message);
    });
  };
  return (
    <form onSubmit={submit} className="panel">
      <h2 style={{ marginTop: 0 }}>Netlify</h2>
      <div className="row">
        <div>
          <label>Site ID <span className="muted">(Site configuration → Site ID, or the site's name)</span></label>
          <input name="netlifySiteId" defaultValue={p.netlifySiteId} placeholder="3f6c…-…  or  my-blog" />
        </div>
        <div>
          <label>
            Personal access token{" "}
            {!p.token.stored ? (
              <span className="muted">(none)</span>
            ) : p.token.unreadable ? (
              <span className="badge">unreadable — re-enter it</span>
            ) : (
              <span className="muted">(stored: <code>{p.token.masked}</code>)</span>
            )}
          </label>
          <input type="password" name="token" autoComplete="off" placeholder={p.token.stored ? "Leave empty to keep the current token" : "User settings → Applications → New access token"} />
        </div>
      </div>
      {p.token.stored && <label className="check"><input type="checkbox" name="clearToken" /> Remove the stored token</label>}
      <label className="check"><input type="checkbox" name="auto" defaultChecked={p.auto} /> Deploy automatically whenever the public site changes</label>
      <p className="muted">
        Create an empty site in Netlify first (Add new site → Deploy manually), then paste its ID here. The token is stored encrypted and never shown again.
        Deploys only upload files that changed, and are skipped when nothing visible changed (e.g. editing a draft).
      </p>
      <p><button disabled={busy}>Save publishing settings</button></p>
    </form>
  );
}
