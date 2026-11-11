import { sha1, type StaticFile } from "./static.js";

/**
 * Minimal Netlify API client for the file-digest deploy method
 * (https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/):
 * 1. POST a manifest { path: sha1 } (async), poll until Netlify lists the `required` hashes;
 * 2. PUT only those files; 3. poll the deploy until it's `ready` (then it's live).
 * Files Netlify already has (from earlier deploys) are never re-uploaded.
 */

export interface NetlifySite {
  id: string;
  name: string;
  /** https URL of the site: the primary custom domain if set, else <name>.netlify.app. */
  url: string;
}
export interface NetlifyDeployResult {
  id: string;
  /** URL of this specific deploy (permalink). */
  deployUrl: string;
  uploaded: number;
}
/** What the publish service needs from a hosting provider (fakes implement it in tests). */
export interface NetlifyApi {
  site(siteId: string): Promise<NetlifySite>;
  deploy(siteId: string, files: StaticFile[]): Promise<NetlifyDeployResult>;
}

export class NetlifyError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

interface DeployJson {
  id: string;
  state?: string;
  required?: string[];
  error_message?: string | null;
  ssl_url?: string;
  deploy_ssl_url?: string;
  deploy_url?: string;
}

type Fetch = typeof fetch;
const API = "https://api.netlify.com/api/v1";

export class NetlifyClient implements NetlifyApi {
  constructor(
    private token: string,
    private opts: { fetch?: Fetch; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, "user-agent": "aicms-static-publisher" };
    let payload: string | Uint8Array<ArrayBuffer> | undefined;
    if (raw) {
      headers["content-type"] = "application/octet-stream";
      payload = new Uint8Array(raw); // copy into a plain ArrayBuffer (fetch's BodyInit)
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    // Uploads of large files can time out on Netlify's side; retrying them is safe.
    for (let attempt = 1; ; attempt++) {
      const res = await f(`${API}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
      // Never retry the POST that creates a deploy (it would create a second deploy).
      const retryable = method !== "POST" && (res.status === 429 || res.status >= 500);
      if (retryable && attempt < 3) {
        await this.sleep(attempt * 1000);
        continue;
      }
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* not JSON */
      }
      if (res.status === 401) msg = "Netlify rejected the access token (401). Create a new personal access token.";
      if (res.status === 404) msg = "Netlify site not found (404). Check the site ID and that the token can access it.";
      throw new NetlifyError(`Netlify API ${method} ${path.split("?")[0]}: ${msg || res.statusText}`, res.status);
    }
  }

  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  async site(siteId: string): Promise<NetlifySite> {
    const s = await this.request<{ id: string; name: string; ssl_url?: string; url?: string }>("GET", `/sites/${encodeURIComponent(siteId)}`);
    const url = (s.ssl_url || s.url || `https://${s.name}.netlify.app`).replace(/^http:/, "https:").replace(/\/+$/, "");
    return { id: s.id, name: s.name, url };
  }

  /** Polls the deploy until `done(state)` is true; throws on `error` or timeout. */
  private async waitFor(siteId: string, id: string, done: (d: DeployJson) => boolean): Promise<DeployJson> {
    const deadline = Date.now() + (this.opts.timeoutMs ?? 5 * 60_000);
    for (;;) {
      const d = await this.request<DeployJson>("GET", `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(id)}`);
      if (d.state === "error") throw new NetlifyError(`Netlify deploy failed: ${d.error_message || "unknown error"}`);
      if (done(d)) return d;
      if (Date.now() > deadline) throw new NetlifyError(`Timed out waiting for the Netlify deploy (state: ${d.state ?? "unknown"}).`);
      await this.sleep(this.opts.pollMs ?? 2000);
    }
  }

  async deploy(siteId: string, files: StaticFile[]): Promise<NetlifyDeployResult> {
    const byHash = new Map<string, StaticFile>();
    const manifest: Record<string, string> = {};
    for (const f of files) {
      const h = sha1(f.data);
      manifest[f.path] = h;
      byHash.set(h, f);
    }
    const created = await this.request<DeployJson>("POST", `/sites/${encodeURIComponent(siteId)}/deploys`, { files: manifest, async: true, draft: false });
    // Async deploys start as "preparing" while Netlify builds the upload manifest.
    const prepared = created.state && created.state !== "preparing" && created.state !== "new"
      ? created
      : await this.waitFor(siteId, created.id, (d) => d.state !== "preparing" && d.state !== "new");
    const required = [...new Set(prepared.required ?? [])];
    for (const h of required) {
      const f = byHash.get(h);
      if (!f) throw new NetlifyError(`Netlify asked for a file we didn't send (${h}).`);
      const path = f.path.split("/").map(encodeURIComponent).join("/");
      await this.request("PUT", `/deploys/${encodeURIComponent(created.id)}/files${path}`, undefined, f.data);
    }
    const ready = prepared.state === "ready" ? prepared : await this.waitFor(siteId, created.id, (d) => d.state === "ready");
    return { id: created.id, deployUrl: ready.deploy_ssl_url || ready.deploy_url || ready.ssl_url || "", uploaded: required.length };
  }
}
