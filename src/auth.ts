import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import type { Repo, UserRow } from "./repo.js";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = "aicms_sid";

export function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: 14 * 24 * 3600 * 1000,
    path: "/",
  });
}

export function csrfToken(sid: string) {
  return crypto.createHmac("sha256", config.secret).update("csrf:" + sid).digest("base64url");
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: UserRow;
      sid?: string;
      csrf?: string;
    }
  }
}

/** Loads the logged-in user (if any) and enforces CSRF on state-changing requests. */
export function sessionMiddleware(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) {
      const user = repo.sessionUser(sid);
      if (user) {
        res.locals.user = user;
        res.locals.sid = sid;
        res.locals.csrf = csrfToken(sid);
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && res.locals.sid) {
      const sent = (req.body?._csrf as string | undefined) ?? req.get("x-csrf-token");
      const expected = res.locals.csrf!;
      if (!sent || sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
        res.status(403).json({ error: "Invalid CSRF token. Reload the page and try again." });
        return;
      }
    }
    next();
  };
}
