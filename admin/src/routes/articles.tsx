import { Link, NavLink, useLoaderData, useNavigate, useSearchParams, type LoaderFunctionArgs } from "react-router";
import type { ArticleSummary } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { ArticleTable, useAction, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => {
  const status = new URL(request.url).searchParams.get("status");
  return load<ArticleSummary[]>(`${tapi(params.tenant!)}/articles${status ? `?status=${encodeURIComponent(status)}` : ""}`, request);
};

const FILTERS = [
  ["", "All"],
  ["review", "Needs review"],
  ["draft", "Drafts"],
  ["published", "Published"],
] as const;

export function Component() {
  const rows = useLoaderData() as ArticleSummary[];
  const tenant = useTenant();
  const [params] = useSearchParams();
  const base = `/${tenant.slug}`;
  const current = params.get("status") ?? "";
  return (
    <>
      <h1>Articles {tenant.can["article.create"] && <Link className="btn sm" to={`${base}/articles/new`}>+ New</Link>}</h1>
      <p className="actions">
        {FILTERS.map(([value, label], i) => (
          <span key={value}>
            {i > 0 && " · "}
            <NavLink to={value ? `${base}/articles?status=${value}` : `${base}/articles`} style={{ fontWeight: value === current ? 700 : 400 }}>{label}</NavLink>
          </span>
        ))}
      </p>
      {tenant.ai.enabled && tenant.can["article.editAny"] && rows.some((a) => a.seoMissing) && <FixSeo count={rows.filter((a) => a.seoMissing).length} />}
      <ArticleTable base={base} rows={rows} />
    </>
  );
}

/** Bulk action: let the AI fill in missing SEO metadata on every published article. */
function FixSeo({ count }: { count: number }) {
  const tenant = useTenant();
  const navigate = useNavigate();
  const [busy, run] = useAction();
  const start = () =>
    run(async () => {
      const { jobId } = await api<{ jobId: number }>(`${tapi(tenant.slug)}/ai/seo`, { body: { target: "articles" } });
      navigate(`/${tenant.slug}/jobs/${jobId}`);
    });
  return (
    <div className="panel ai">
      {count} published article{count === 1 ? " is" : "s are"} missing search-engine metadata (marked <span className="badge seo-missing">SEO</span>).{" "}
      <button className="sm" onClick={start} disabled={busy}>✨ Fill it in with AI</button>{" "}
      <span className="muted">Only empty fields are filled; nothing you wrote is changed.</span>
    </div>
  );
}
