import type { DeployRow, Repo, Tenant } from "../repo.js";
import { decryptSecret } from "../util/secrets.js";
import { NetlifyClient, type NetlifyApi } from "./netlify.js";
import { buildStaticSite, exportHash } from "./static.js";

export type NetlifyFactory = (token: string) => NetlifyApi;

export class PublishError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/** Whether a site can be published statically, and why not. */
export type PublishReadiness = { ok: true; siteId: string; token: string } | { ok: false; reason: string };

/**
 * Static publishing: renders a tenant's public site to files (publish/static.ts) and deploys them
 * to Netlify. Deploys run in-process, one at a time per tenant. Automatic deploys are debounced
 * after any change to the public site (Repo.onSiteChange) and skipped when the export is identical
 * to the last successful deploy, so editing drafts costs one render and no deploy.
 */
export class PublishService {
  private timers = new Map<number, NodeJS.Timeout>();
  /** Tail of each tenant's deploy queue. */
  private queues = new Map<number, Promise<void>>();
  /** Tenants with an automatic deploy queued but not started (coalesces bursts of changes). */
  private autoQueued = new Set<number>();
  private debounceMs: number;
  private factory: NetlifyFactory;

  constructor(private repo: Repo, opts: { netlify?: NetlifyFactory; debounceMs?: number } = {}) {
    this.factory = opts.netlify ?? ((token) => new NetlifyClient(token));
    this.debounceMs = opts.debounceMs ?? 10_000;
  }

  readiness(t: Tenant): PublishReadiness {
    const siteId = t.settings.publish.netlifySiteId;
    if (!siteId) return { ok: false, reason: "Static publishing isn't set up: add a Netlify site ID." };
    const stored = this.repo.tenantPublishToken(t.id);
    if (!stored) return { ok: false, reason: "Static publishing isn't set up: add a Netlify access token." };
    const token = decryptSecret(stored);
    if (!token) return { ok: false, reason: "The stored Netlify token can't be read (APP_SECRET changed?). Enter it again." };
    return { ok: true, siteId, token };
  }

  /** Called on every public-site change: schedules a debounced automatic deploy if enabled. */
  schedule(tenantId: number) {
    const t = this.repo.tenantById(tenantId);
    if (!t || !t.settings.publish.auto || !this.readiness(t).ok) return;
    clearTimeout(this.timers.get(tenantId));
    const timer = setTimeout(() => {
      this.timers.delete(tenantId);
      if (this.autoQueued.has(tenantId)) return; // one queued auto deploy will pick up this change too
      this.autoQueued.add(tenantId);
      this.enqueue(tenantId, () => {
        this.autoQueued.delete(tenantId);
        return this.execute(tenantId, { trigger: "auto", userId: null, force: false });
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(tenantId, timer);
  }

  /** Deploys now (after any running deploy of this site), even if nothing changed. Returns the deploy record id. */
  requestDeploy(t: Tenant, userId: number | null): number {
    const ready = this.readiness(t);
    if (!ready.ok) throw new PublishError(ready.reason);
    const id = this.repo.createDeploy(t.id, { userId, trigger: "manual", siteId: ready.siteId });
    this.enqueue(t.id, () => this.execute(t.id, { trigger: "manual", userId, force: true, recordId: id }));
    return id;
  }

  isBusy(tenantId: number) {
    return this.timers.has(tenantId) || this.queues.has(tenantId);
  }

  /** Resolves once no deploy is scheduled or running (tests, graceful shutdown). */
  async idle() {
    while (this.timers.size || this.queues.size) {
      await Promise.all([...this.queues.values()]);
      if (this.timers.size) await new Promise((r) => setTimeout(r, Math.min(this.debounceMs, 50) + 1));
    }
  }

  private enqueue(tenantId: number, fn: () => Promise<void>) {
    const tail = (this.queues.get(tenantId) ?? Promise.resolve())
      .then(fn)
      .catch((e) => console.error("[publish]", e))
      .finally(() => {
        if (this.queues.get(tenantId) === tail) this.queues.delete(tenantId);
      });
    this.queues.set(tenantId, tail);
  }

  private async execute(tenantId: number, o: { trigger: DeployRow["trigger"]; userId: number | null; force: boolean; recordId?: number }) {
    let id = o.recordId;
    const t = this.repo.tenantById(tenantId);
    if (!t) return;
    const ready = this.readiness(t);
    if (!ready.ok) {
      if (id) this.repo.finishDeploy(t.id, id, { status: "failed", error: ready.reason });
      return;
    }
    const record = () => (id ??= this.repo.createDeploy(t.id, { userId: o.userId, trigger: o.trigger, siteId: ready.siteId }));
    let hash: string | null = null;
    let files = 0;
    try {
      const netlify = this.factory(ready.token);
      const site = await netlify.site(ready.siteId);
      // Re-read the tenant: settings may have changed while waiting in the queue.
      const fresh = this.repo.tenantById(tenantId) ?? t;
      const exported = buildStaticSite(this.repo, fresh, site.url);
      hash = exportHash(exported);
      files = exported.length;
      const last = this.repo.lastSucceededDeploy(t.id, ready.siteId);
      if (!o.force && last?.hash === hash) return; // nothing changed since the last deploy (e.g. a draft was edited)
      record();
      const res = await netlify.deploy(ready.siteId, exported);
      this.repo.finishDeploy(t.id, id!, { status: "succeeded", deployId: res.id, url: site.url, files, uploaded: res.uploaded, hash });
    } catch (e) {
      record();
      const msg = e instanceof Error ? e.message : String(e);
      this.repo.finishDeploy(t.id, id!, { status: "failed", files, hash: null, error: msg.slice(0, 500) });
    }
  }
}
