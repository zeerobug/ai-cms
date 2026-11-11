import { Link, NavLink, useLoaderData, useSearchParams, type LoaderFunctionArgs } from "react-router";
import type { ArticleSummary } from "../../../src/web/admin-types";
import { load, tapi } from "../api";
import { ArticleTable, useTenant } from "../ui";

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
      <ArticleTable base={base} rows={rows} />
    </>
  );
}
