import express, { type RequestHandler } from "express";
import { AiService, createProvider, type ProviderFactory } from "./ai/service.js";
import type { AIProvider } from "./ai/provider.js";
import { sessionMiddleware } from "./auth.js";
import { openDb, type DB } from "./db.js";
import { PublishService, type NetlifyFactory } from "./publish/service.js";
import { httpPoster, type SocialPoster } from "./social/networks.js";
import { SocialService } from "./social/service.js";
import { Repo } from "./repo.js";
import { adminApiRouter } from "./web/admin-api.js";
import { adminPreviewRouter } from "./web/admin-previews.js";
import { apiRouter } from "./web/api.js";
import { mediaRouter } from "./web/media.js";
import { hostTenant, pathTenant, siteRouter } from "./web/site.js";

/**
 * @param opts.adminUi serves the React admin (see web/admin-spa.ts); omitted in tests, which use
 *                     the JSON API directly.
 * @param opts.netlify builds the Netlify client for static publishing (fakes in tests).
 * @param opts.publishDebounceMs delay before an automatic static deploy after a change (default 10 s).
 * @param opts.socialPoster publishes posts to LinkedIn / X / Facebook (fakes in tests).
 * @param opts.socialDebounceMs delay before automatic social posts after a change (default 15 s).
 */
export function createApp(
  opts: { db?: DB; provider?: AIProvider; providerFactory?: ProviderFactory; adminUi?: RequestHandler; netlify?: NetlifyFactory; publishDebounceMs?: number; socialPoster?: SocialPoster; socialDebounceMs?: number } = {},
) {
  const db = opts.db ?? openDb();
  const repo = new Repo(db);
  const ai = new AiService(repo, opts.provider ?? createProvider(), opts.providerFactory);
  const publish = new PublishService(repo, { netlify: opts.netlify, debounceMs: opts.publishDebounceMs });
  // Any change to a public site (from the admin, the REST API or AI jobs) can republish its static export.
  repo.onSiteChange((tenantId) => publish.schedule(tenantId));
  // Social posts link to the public site, so they wait for a pending static deploy (at most 5 minutes).
  const social = new SocialService(repo, opts.socialPoster ?? httpPoster(), {
    debounceMs: opts.socialDebounceMs,
    settle: async (tenantId) => {
      for (let i = 0; i < 300 && publish.isBusy(tenantId); i++) await new Promise((r) => setTimeout(r, 1000));
    },
  });
  repo.onSiteChange((tenantId) => social.schedule(tenantId));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/v1", apiRouter(repo, ai));
  app.use("/admin", sessionMiddleware(repo));
  app.use("/admin/api", adminApiRouter(repo, ai, publish, social));
  app.use("/admin", adminPreviewRouter(repo));
  if (opts.adminUi) app.use(opts.adminUi);

  // Uploaded / AI-generated images, on every host (before the public sites claim the path).
  app.use("/media", mediaRouter(repo));

  // Public sites: custom domain / subdomain first, then /s/:tenant path prefix.
  const site = siteRouter(repo);
  app.use(hostTenant(repo), (req, res, next) => (res.locals.tenant ? site(req, res, next) : next()));
  app.use("/s/:tenant", pathTenant(repo), site);

  app.get("/", (_req, res) => res.redirect("/admin"));
  // The platform host itself (admin, /s/ paths): keep crawlers out of the admin.
  app.get("/robots.txt", (_req, res) => void res.type("text/plain").send("User-agent: *\nDisallow: /admin\n"));

  return { app, repo, ai, publish, social, db };
}
