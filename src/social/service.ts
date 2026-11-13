import type { ArticleRow, Repo, Tenant } from "../repo.js";
import { safeJson } from "../repo.js";
import { config } from "../config.js";
import { SOCIAL_NETWORKS, type SocialNetwork } from "../tenancy.js";
import { decryptSecret, encryptSecret } from "../util/secrets.js";
import { composePost, networkGap, type SocialCreds, type SocialIds, type SocialPoster } from "./networks.js";

export class SocialError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/**
 * Shares published articles on LinkedIn, X and Facebook, in-process like deploys and AI jobs.
 *
 * Automatic posting is driven by `Repo.onSiteChange` (so it covers articles published from the admin,
 * the REST API and AI jobs alike): a debounced run posts every article that was published since the
 * owner turned auto-posting on (`settings.social.autoSince`) and has no attempt yet on a network.
 * Each attempt is a `social_posts` row created *before* the request, so a crash or failure never
 * leads to a second automatic post; a failed attempt is retried only by a person.
 */
export class SocialService {
  private timers = new Map<number, NodeJS.Timeout>();
  private queues = new Map<number, Promise<void>>();
  private autoQueued = new Set<number>();
  private debounceMs: number;

  /**
   * @param opts.settle resolves when the public site is safe to link to (e.g. after a pending static deploy).
   */
  constructor(
    private repo: Repo,
    private poster: SocialPoster,
    opts: { debounceMs?: number; settle?: (tenantId: number) => Promise<void> } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 15_000;
    this.settle = opts.settle ?? (async () => {});
  }
  private settle: (tenantId: number) => Promise<void>;

  // ---- credentials -----------------------------------------------------------

  /** The tenant's stored credentials. `unreadable` = stored but can't be decrypted (APP_SECRET changed). */
  credentials(tenantId: number): { creds: SocialCreds; unreadable: boolean } {
    const stored = this.repo.tenantSocialCreds(tenantId);
    if (!stored) return { creds: {}, unreadable: false };
    const plain = decryptSecret(stored);
    return { creds: plain ? safeJson<SocialCreds>(plain, {}) : {}, unreadable: !plain };
  }

  /** Merges `patch` into the stored credentials (a network's empty fields keep their value) and drops the `clear`ed networks. */
  saveCredentials(tenantId: number, patch: Partial<Record<SocialNetwork, Record<string, string>>>, clear: SocialNetwork[] = []) {
    const { creds, unreadable } = this.credentials(tenantId);
    const next: Record<string, Record<string, string>> = unreadable ? {} : { ...(creds as Record<string, Record<string, string>>) };
    for (const n of clear) delete next[n];
    for (const n of SOCIAL_NETWORKS) {
      const fields = Object.fromEntries(Object.entries(patch[n] ?? {}).filter(([, v]) => v));
      if (Object.keys(fields).length) next[n] = { ...next[n], ...fields };
    }
    this.repo.setTenantSocialCreds(tenantId, Object.keys(next).length ? encryptSecret(JSON.stringify(next)) : null);
  }

  // ---- readiness ---------------------------------------------------------------

  static ids(t: Tenant): SocialIds {
    return { linkedinAuthor: t.settings.social.linkedinAuthor, facebookPageId: t.settings.social.facebookPageId };
  }

  /** The public root URL articles are linked under, or null when the site has no public address yet. */
  siteRoot(t: Tenant): string | null {
    const s = t.settings.social;
    let root = s.siteUrl;
    if (!root) {
      const id = t.settings.publish.netlifySiteId;
      root = (id && this.repo.lastSucceededDeploy(t.id, id)?.url) || "";
    }
    if (!root && t.domain) root = `https://${t.domain}`;
    if (!root && config.baseDomain) root = `https://${t.slug}.${config.baseDomain}`;
    return root ? root.replace(/\/+$/, "") : null;
  }

  articleUrl(t: Tenant, a: Pick<ArticleRow, "slug">) {
    const root = this.siteRoot(t);
    return root ? `${root}/a/${encodeURIComponent(a.slug)}` : null;
  }

  /** For each network: whether it's switched on, and why it can't post (null = ready). */
  networkStates(t: Tenant) {
    const { creds, unreadable } = this.credentials(t.id);
    return SOCIAL_NETWORKS.map((network) => ({
      network,
      enabled: t.settings.social.networks.includes(network),
      gap: unreadable ? "The stored credentials can't be read (APP_SECRET changed?). Enter them again." : networkGap(network, creds, SocialService.ids(t)),
    }));
  }

  // ---- automatic posting ---------------------------------------------------------

  /** Called on every public-site change: schedules a debounced automatic run when auto-posting is on. */
  schedule(tenantId: number) {
    const t = this.repo.tenantById(tenantId);
    const s = t?.settings.social;
    if (!t || !s?.auto || !s.autoSince || !s.networks.length) return;
    clearTimeout(this.timers.get(tenantId));
    const timer = setTimeout(() => {
      this.timers.delete(tenantId);
      if (this.autoQueued.has(tenantId)) return; // the queued run will pick this change up too
      this.autoQueued.add(tenantId);
      this.enqueue(tenantId, async () => {
        this.autoQueued.delete(tenantId);
        await this.runAuto(tenantId);
      });
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(tenantId, timer);
  }

  private async runAuto(tenantId: number) {
    await this.settle(tenantId);
    const t = this.repo.tenantById(tenantId); // settings may have changed while waiting
    if (!t || !t.settings.social.auto || !t.settings.social.autoSince) return;
    for (const state of this.networkStates(t)) {
      if (!state.enabled || state.gap) continue;
      for (const article of this.repo.articlesToShare(t.id, state.network, t.settings.social.autoSince)) {
        const url = this.articleUrl(t, article);
        if (!url) return;
        const id = this.repo.createSocialPost(t.id, { articleId: article.id, network: state.network, trigger: "auto", userId: null, text: "" });
        await this.send(t, article, state.network, url, id);
      }
    }
  }

  // ---- manual posting --------------------------------------------------------------

  /** Queues a post of a published article to each network now. Returns the post record ids. */
  requestPost(t: Tenant, userId: number | null, article: ArticleRow, networks: SocialNetwork[], text?: string): number[] {
    if (article.status !== "published") throw new SocialError("Only published articles can be shared.");
    const url = this.articleUrl(t, article);
    if (!url) throw new SocialError("Set the site's public URL first (Social → Site URL), or add a custom domain or static publishing.");
    const states = new Map(this.networkStates(t).map((s) => [s.network, s]));
    for (const n of networks) {
      const gap = states.get(n)?.gap;
      if (gap) throw new SocialError(gap);
    }
    const ids = networks.map((network) => {
      const id = this.repo.createSocialPost(t.id, { articleId: article.id, network, trigger: "manual", userId, text: "" });
      this.enqueue(t.id, async () => {
        const fresh = this.repo.tenantById(t.id) ?? t;
        await this.send(fresh, article, network, url, id, text);
      });
      return id;
    });
    return ids;
  }

  isBusy(tenantId: number) {
    return this.timers.has(tenantId) || this.queues.has(tenantId);
  }

  /** Resolves once nothing is scheduled or running (tests, graceful shutdown). */
  async idle() {
    while (this.timers.size || this.queues.size) {
      await Promise.all([...this.queues.values()]);
      if (this.timers.size) await new Promise((r) => setTimeout(r, Math.min(this.debounceMs, 50) + 1));
    }
  }

  private enqueue(tenantId: number, fn: () => Promise<void>) {
    const tail = (this.queues.get(tenantId) ?? Promise.resolve())
      .then(fn)
      .catch((e) => console.error("[social]", e))
      .finally(() => {
        if (this.queues.get(tenantId) === tail) this.queues.delete(tenantId);
      });
    this.queues.set(tenantId, tail);
  }

  /** Posts one article to one network and records the outcome on the (already created) record `id`. */
  private async send(t: Tenant, article: ArticleRow, network: SocialNetwork, url: string, id: number, override?: string) {
    let text = "";
    try {
      const { creds } = this.credentials(t.id);
      const gap = networkGap(network, creds, SocialService.ids(t));
      if (gap) throw new Error(gap);
      const tags = safeJson<string[]>(article.tags, []);
      text = composePost(network, { title: article.title, summary: article.summary, tags }, url, override);
      const res = await this.poster(network, creds, SocialService.ids(t), { text, url, title: article.title, description: article.summary || article.seo_description });
      this.repo.finishSocialPost(t.id, id, { status: "posted", text, postId: res.id, url: res.url });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.repo.finishSocialPost(t.id, id, { status: "failed", text, error: msg.slice(0, 500) });
    }
  }
}
