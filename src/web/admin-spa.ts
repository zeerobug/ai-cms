import fs from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";

/**
 * Serves the React admin (admin/) under /admin. Mount it after the admin API and previews.
 *
 * - dev: Vite in middleware mode (HMR, on-the-fly TSX), same port as the app.
 * - production: the static build from `pnpm build` (dist/admin), with index.html as SPA fallback.
 *
 * Pages are code-split: each route is a lazily imported chunk (see admin/src/main.tsx).
 */
export async function adminSpa(opts: { dev: boolean }): Promise<RequestHandler> {
  const r = express.Router();
  const root = path.resolve("admin");

  if (opts.dev) {
    // Imported lazily so production never needs the dev dependency.
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
    const isAdmin = (url: string) => url === "/admin" || url.startsWith("/admin/") || url.startsWith("/admin?");
    // Only admin URLs go through Vite. Note: Vite strips its base from req.url, so match on originalUrl.
    r.use((req, res, next) => (isAdmin(req.originalUrl) ? vite.middlewares(req, res, next) : next()));
    r.use(async (req, res, next) => {
      if (req.method !== "GET" || !isAdmin(req.originalUrl)) return next();
      try {
        const template = await fs.promises.readFile(path.join(root, "index.html"), "utf8");
        res.type("html").send(await vite.transformIndexHtml(req.originalUrl, template));
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
    return r;
  }

  const dist = path.resolve("dist/admin");
  const index = path.join(dist, "index.html");
  // Hashed asset names: cache forever. index.html: never cache (it points at the current chunks).
  r.use("/admin/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  r.get("/admin{/*path}", (_req, res) => {
    if (!fs.existsSync(index)) return void res.status(503).type("text").send("Admin UI is not built. Run `pnpm build`.");
    res.set("Cache-Control", "no-cache").sendFile(index);
  });
  return r;
}
