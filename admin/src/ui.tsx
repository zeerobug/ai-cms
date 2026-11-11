import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { isRouteErrorResponse, Link, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import type { ArticleSummary, JobSummary, Role, TenantInfo } from "../../src/web/admin-types";
import { ROLE_LIST } from "../../src/web/admin-types";

// ---- flash messages ------------------------------------------------------------------------

type Flash = { kind: "ok" | "err"; text: string } | null;
const FlashCtx = createContext<{ flash: Flash; notify: (text: string) => void; fail: (e: unknown) => void }>(null!);

/** Messages survive one navigation when passed as `navigate(to, { state: { flash } })`. */
export function FlashProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [flash, setFlash] = useState<Flash>(null);
  useEffect(() => {
    const f = (location.state as { flash?: string } | null)?.flash;
    setFlash(f ? { kind: "ok", text: f } : null);
  }, [location.key]);
  const notify = useCallback((text: string) => setFlash({ kind: "ok", text }), []);
  const fail = useCallback((e: unknown) => setFlash({ kind: "err", text: e instanceof Error ? e.message : String(e) }), []);
  return <FlashCtx.Provider value={{ flash, notify, fail }}>{children}</FlashCtx.Provider>;
}
export const useFlash = () => useContext(FlashCtx);

export function FlashBanner() {
  const { flash } = useFlash();
  if (!flash) return null;
  return <div className={`flash ${flash.kind === "err" ? "err" : ""}`}>{flash.text}</div>;
}

/** Runs an async action with a busy flag; errors become an error flash. */
export function useAction() {
  const { fail } = useFlash();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );
  return [busy, run] as const;
}

// ---- tenant context ------------------------------------------------------------------------

/** Data of the current site, loaded once by the tenant layout route (id "tenant"). */
export const useTenant = () => useRouteLoaderData("tenant") as TenantInfo;

// ---- small components ----------------------------------------------------------------------

export const StatusBadge = ({ status }: { status: string }) => <span className={`badge b-${status}`}>{status}</span>;
export const AiBadge = () => <span className="badge b-ai">AI</span>;

export function RoleSelect({ name, defaultValue }: { name: string; defaultValue: Role }) {
  return (
    <select name={name} defaultValue={defaultValue}>
      {ROLE_LIST.map((r) => (
        <option key={r}>{r}</option>
      ))}
    </select>
  );
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <span className="spinner" />
    </div>
  );
}

export function ArticleTable({ base, rows }: { base: string; rows: ArticleSummary[] }) {
  if (!rows.length) return <div className="panel muted">No articles yet.</div>;
  return (
    <table>
      <thead>
        <tr><th>Title</th><th>Status</th><th>Source</th><th>Updated</th><th></th></tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <td><Link to={`${base}/articles/${a.id}`}>{a.title}</Link></td>
            <td><StatusBadge status={a.status} /></td>
            <td>{a.source === "ai" ? <AiBadge /> : "human"}</td>
            <td className="muted">{a.updatedAt}</td>
            <td><a href={`/admin${base}/articles/${a.id}/preview`} target="_blank" rel="noreferrer">Preview</a></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function JobsTable({ base, jobs }: { base: string; jobs: JobSummary[] }) {
  if (!jobs.length) return <div className="panel muted">No AI jobs yet.</div>;
  return (
    <table>
      <thead>
        <tr><th>#</th><th>Kind</th><th>Request</th><th>Status</th><th>When</th></tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td><Link to={`${base}/jobs/${j.id}`}>{j.id}</Link></td>
            <td>{j.kind}</td>
            <td>{j.request.slice(0, 80)}</td>
            <td><StatusBadge status={j.status} />{j.error && <span className="muted"> {j.error.slice(0, 80)}</span>}</td>
            <td className="muted">{j.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ErrorPage() {
  const err = useRouteError();
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : "Something went wrong.";
  return (
    <div className="panel">
      <h1>Oops</h1>
      <p>{message}</p>
      <Link to="/">Back to your sites</Link>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="panel">
      <h1>Page not found</h1>
      <Link to="/">Back to your sites</Link>
    </div>
  );
}

/** Reads FormData into a plain object of strings; checkboxes become booleans via `checked()`. */
export const field = (fd: FormData, name: string) => String(fd.get(name) ?? "");
export const checked = (fd: FormData, name: string) => fd.get(name) === "on";
