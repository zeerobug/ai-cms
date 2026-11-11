import { useState, type FormEvent } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { Dashboard } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { ArticleTable, checked, field, JobsTable, useAction, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<Dashboard>(`${tapi(params.tenant!)}/dashboard`, request);

export function Component() {
  const data = useLoaderData() as Dashboard;
  const tenant = useTenant();
  const base = `/${tenant.slug}`;
  return (
    <>
      <h1>{tenant.name}</h1>
      {tenant.ai.enabled ? <AiArticleForm /> : <div className="panel">AI is disabled for this site.</div>}
      <h2>Recent articles {tenant.can["article.create"] && <Link className="btn sm sec" to={`${base}/articles/new`}>+ New article</Link>}</h2>
      <ArticleTable base={base} rows={data.recentArticles} />
      <h2>Recent AI jobs</h2>
      <JobsTable base={base} jobs={data.jobs} />
    </>
  );
}

function AiArticleForm() {
  const tenant = useTenant();
  const navigate = useNavigate();
  const [busy, run] = useAction();
  const [designLook, setDesignLook] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    run(async () => {
      const { jobId } = await api<{ jobId: number }>(`${tapi(tenant.slug)}/ai/article`, {
        body: {
          topic: field(fd, "topic"),
          instructions: field(fd, "instructions"),
          tone: field(fd, "tone"),
          length: field(fd, "length"),
          publish: checked(fd, "publish"),
          designLook,
          designBrief: field(fd, "designBrief"),
        },
      });
      navigate(`/${tenant.slug}/jobs/${jobId}`);
    });
  };
  return (
    <form onSubmit={submit} className="panel ai">
      <h2 style={{ marginTop: 0 }}>✨ Ask the AI to write an article</h2>
      <label>What should it be about?</label>
      <input name="topic" required minLength={3} placeholder="e.g. How small cafés can use loyalty programs without an app" />
      <label>Extra instructions (optional)</label>
      <textarea name="instructions" style={{ minHeight: "4rem" }} placeholder="Angle, audience, key points, links to include…" />
      <div className="row">
        <div><label>Tone</label><input name="tone" placeholder={tenant.ai.defaultTone} /></div>
        <div>
          <label>Length</label>
          <select name="length" defaultValue={tenant.ai.defaultLength}>
            {["short", "medium", "long"].map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" name="publish" defaultChecked /> Publish when done
        <span className="muted">{tenant.ai.canAutoPublish ? "(allowed by site settings)" : "(site settings require review — it will go to the review queue)"}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={designLook} onChange={(e) => setDesignLook(e.target.checked)} /> Also design a custom look for this article
      </label>
      {designLook && <input name="designBrief" placeholder="Optional design brief, e.g. warm, rustic, handwritten feel" />}
      <p>
        <button disabled={busy}>Write it</button>{" "}
        {tenant.ai.provider === "mock" && (
          <span className="muted">Running in <strong>mock AI</strong> mode — choose a real provider in Settings (or set <code>ANTHROPIC_API_KEY</code>) for real articles.</span>
        )}
      </p>
    </form>
  );
}
