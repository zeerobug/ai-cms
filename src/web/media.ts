import express from "express";
import { MEDIA_FILE_RE } from "../content/media.js";
import type { Repo } from "../repo.js";

/**
 * Public image files: GET /media/:tenant/:file. Mounted before the public sites so the same
 * URL works on /s/<tenant>, BASE_DOMAIN subdomains and custom domains alike.
 * File names are random, and the content was verified as PNG/JPEG/WebP/GIF on upload.
 */
export function mediaRouter(repo: Repo) {
  const r = express.Router();
  r.get("/:tenant/:file", (req, res) => {
    const file = req.params.file;
    const row = MEDIA_FILE_RE.test(file) ? repo.mediaFile(req.params.tenant, file) : undefined;
    if (!row) return void res.status(404).type("text/plain").send("Not found");
    res.set({
      "Content-Type": row.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.send(Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength));
  });
  return r;
}
