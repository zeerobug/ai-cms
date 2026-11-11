import { useSyncExternalStore } from "react";
import { redirect } from "react-router";
import type { SessionInfo } from "../../src/web/admin-types";

/** Error returned by the admin API ({ error } body + HTTP status). */
export class ApiFailure extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---- session store (user + CSRF token), shared by the header and every request -------------

let session: SessionInfo = { user: null, csrf: null };
const listeners = new Set<() => void>();

export function setSession(s: SessionInfo) {
  session = s;
  listeners.forEach((l) => l());
}
export const getSession = () => session;
export function useSession() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => session,
  );
}

// ---- fetch wrapper -------------------------------------------------------------------------

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** Calls /admin/api<path>. Mutations send JSON plus the CSRF header (both required server-side). */
export async function api<T>(path: string, opts: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (session.csrf) headers["x-csrf-token"] = session.csrf;
    body = JSON.stringify(opts.body ?? {});
  }
  const res = await fetch(`/admin/api${path}`, { method, headers, body, credentials: "same-origin", signal: opts.signal });
  return parse<T>(res);
}

/** POSTs a file as the raw request body (used for image uploads; the server checks the bytes). */
export async function upload<T>(path: string, file: Blob, query: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": file.type || "application/octet-stream" };
  if (session.csrf) headers["x-csrf-token"] = session.csrf;
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`/admin/api${path}${qs ? `?${qs}` : ""}`, { method: "POST", headers, body: file, credentials: "same-origin" });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  return data as T;
}

/** For route loaders: GET with abort support; a 401 sends the user to the login page. */
export async function load<T>(path: string, request: Request): Promise<T> {
  try {
    return await api<T>(path, { signal: request.signal });
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) {
      setSession({ user: null, csrf: null });
      throw redirect("/login");
    }
    throw e;
  }
}

/** Base path of a tenant's API. */
export const tapi = (tenant: string) => `/t/${encodeURIComponent(tenant)}`;
