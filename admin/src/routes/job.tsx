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
        {!done && <div><span className="spinner" /> Working… the AI is {job.kind === "article" ? "writing" : "designing"}. This page updates automatically.</div>}
        {job.status === "failed" && (
          <>
            <p>❌ {job.error || "Failed"}</p>
            <Link className="btn sec" to={base}>Back</Link>
          </>
        )}
        {job.status === "succeeded" && r && (
          <>
            <p>✅ {r.message}</p>
            <div className="actions">
              {r.articleId && (
                <>
                  <Link className="btn" to={`${base}/articles/${r.articleId}`}>Edit article</Link>
                  <a className="btn sec" href={`/admin${base}/articles/${r.articleId}/preview`} target="_blank" rel="noreferrer">Preview</a>
                </>
              )}
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
