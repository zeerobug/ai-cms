import express, { type RequestHandler } from "express";
import { AiService, createProvider, type ProviderFactory } from "./ai/service.js";
import type { AIProvider } from "./ai/provider.js";
import { sessionMiddleware } from "./auth.js";
import { openDb, type DB } from "./db.js";
import { Repo } from "./repo.js";
import { adminApiRouter } from "./web/admin-api.js";
import { adminPreviewRouter } from "./web/admin-previews.js";
import { apiRouter } from "./web/api.js";
import { hostTenant, pathTenant, siteRouter } from "./web/site.js";

/**
 * @param opts.adminUi serves the React admin (see web/admin-spa.ts); omitted in tests, which use
 *                     the JSON API directly.
 */
export function createApp(opts: { db?: DB; provider?: AIProvider; providerFactory?: ProviderFactory; adminUi?: RequestHandler } = {}) {
  const db = opts.db ?? openDb();
  const repo = new Repo(db);
  const ai = new AiService(repo, opts.provider ?? createProvider(), opts.providerFactory);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/v1", apiRouter(repo, ai));
  app.use("/admin", sessionMiddleware(repo));
  app.use("/admin/api", adminApiRouter(repo, ai));
  app.use("/admin", adminPreviewRouter(repo));
  if (opts.adminUi) app.use(opts.adminUi);

  // Public sites: custom domain / subdomain first, then /s/:tenant path prefix.
  const site = siteRouter(repo);
  app.use(hostTenant(repo), (req, res, next) => (res.locals.tenant ? site(req, res, next) : next()));
  app.use("/s/:tenant", pathTenant(repo), site);

  app.get("/", (_req, res) => res.redirect("/admin"));

  return { app, repo, ai, db };
}
