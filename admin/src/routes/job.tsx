import { useEffect, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { JobDetail } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<JobDetail>(`${tapi(params.tenant!)}/jobs/${params.id}`, request);

/** Shows an AI job and polls until it finishes. */
export function Component() {
  const initial = useLoaderData() as JobDetail;
  const tenant = useTenant();
  const [job, setJob] = useState(initial);
  useEffect(() => setJob(initial), [initial]);

  const done = job.status === "succeeded" || job.status === "failed";
  useEffect(() => {
    if (done) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api<JobDetail>(`${tapi(tenant.slug)}/jobs/${job.id}`, { signal: ctrl.signal }).then(setJob, () => {});
    }, 1500);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [job, done, tenant.slug]);

  const base = `/${tenant.slug}`;
  const r = job.result;
  return (
    <>
      <h1>AI {job.kind} job #{job.id}</h1>
      <div className="panel">
        <p><strong>Request:</strong> {job.request}</p>
        {!done && <div><span className="spinner" /> Working… the AI is {{ article: "writing", theme: "designing", seo: "optimizing for search engines" }[job.kind]}. This page updates automatically.</div>}
        {job.status === "failed" && (
          <>
            <p>❌ {job.error || "Failed"}</p>
            <Link className="btn sec" to={base}>Back</Link>
          </>
        )}
        {job.status === "succeeded" && r && (
          <>
            <p>✅ {r.message}</p>
            {r.focusKeyword && <p><strong>Focus keyword:</strong> {r.focusKeyword}</p>}
            {r.description && <p><strong>Home page description:</strong> {r.description}</p>}
            {!!r.suggestions?.length && (
              <div className="panel">
                <strong>Suggestions from the AI</strong> <span className="muted">(not applied: edit the content if you agree)</span>
                <ul>{r.suggestions.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            <div className="actions">
              {r.articleId && (
                <>
                  <Link className="btn" to={`${base}/articles/${r.articleId}`}>Edit article</Link>
                  <a className="btn sec" href={`/admin${base}/articles/${r.articleId}/preview`} target="_blank" rel="noreferrer">Preview</a>
                </>
              )}
              {job.kind === "seo" && r.description !== undefined && <Link className="btn sec" to={`${base}/settings`}>Go to Settings</Link>}
              {job.kind === "seo" && r.optimized !== undefined && <Link className="btn sec" to={`${base}/articles?status=published`}>Published articles</Link>}
              {r.themeId && (
                <>
                  <a className="btn sec" href={`/admin${base}/design/${r.themeId}/preview`} target="_blank" rel="noreferrer">Preview design</a>
                  <Link className="btn sec" to={`${base}/design`}>Go to Design</Link>
                </>
              )}
            </div>
            {job.usage && <p className="muted">{job.usage.map((u) => `${u.model}: ${u.inputTokens} in / ${u.outputTokens} out tokens`).join(" · ")}</p>}
          </>
        )}
      </div>
    </>
  );
}
