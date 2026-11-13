import crypto from "node:crypto";
import type { SocialNetwork } from "../tenancy.js";

/**
 * Social networks: what each one needs, how to word a post for it, and a minimal client that
 * publishes it. Clients only use `fetch`; tests inject a fake `SocialPoster` instead.
 */

export const NETWORK_LABELS: Record<SocialNetwork, string> = { linkedin: "LinkedIn", x: "X", facebook: "Facebook" };

/** Secret credentials per network (stored encrypted as one JSON blob, see social/service.ts). */
export interface SocialCreds {
  linkedin?: { token: string };
  x?: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
  facebook?: { token: string };
}

/** The secret fields each network needs, with labels for the admin form. */
export const CRED_FIELDS: Record<SocialNetwork, { key: string; label: string }[]> = {
  linkedin: [{ key: "token", label: "Access token" }],
  x: [
    { key: "apiKey", label: "API key (consumer key)" },
    { key: "apiSecret", label: "API key secret" },
    { key: "accessToken", label: "Access token" },
    { key: "accessSecret", label: "Access token secret" },
  ],
  facebook: [{ key: "token", label: "Page access token" }],
};

/** Non-secret settings a network needs besides its credentials. */
export interface SocialIds {
  linkedinAuthor: string;
  facebookPageId: string;
}

/** Why a network can't post yet, or null when it has everything. */
export function networkGap(network: SocialNetwork, creds: SocialCreds, ids: SocialIds): string | null {
  const c = creds[network] as Record<string, string> | undefined;
  if (!c || CRED_FIELDS[network].some((f) => !c[f.key])) return `${NETWORK_LABELS[network]} credentials are missing.`;
  if (network === "linkedin" && !ids.linkedinAuthor) return "LinkedIn needs an author URN (urn:li:person:… or urn:li:organization:…).";
  if (network === "facebook" && !ids.facebookPageId) return "Facebook needs a Page ID.";
  return null;
}

export interface PostContent {
  /** The text of the post (already fitted to the network's limits). */
  text: string;
  /** The article's public URL. */
  url: string;
  title: string;
  description: string;
}
export interface PostResult {
  id: string;
  url: string | null;
}
/** Publishes one post. Throws an Error with a readable message on failure. */
export type SocialPoster = (network: SocialNetwork, creds: SocialCreds, ids: SocialIds, post: PostContent) => Promise<PostResult>;

// ---- wording -----------------------------------------------------------------------------

const LIMITS: Record<SocialNetwork, number> = { linkedin: 3000, x: 280, facebook: 5000 };
/** X counts every URL as 23 characters whatever its length. */
const X_URL = 23;

export const hashtags = (tags: string[]) =>
  tags
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean)
    .slice(0, 4)
    .map((t) => `#${t}`);

function clip(s: string, max: number) {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/**
 * The default wording of a post: title, summary and hashtags from the article's tags. X posts carry the
 * link inside the text; LinkedIn and Facebook attach it as a link card, so it isn't repeated in the text.
 * `override` replaces title + summary (the user's own wording), still fitted to the limit.
 */
export function composePost(network: SocialNetwork, a: { title: string; summary: string; tags: string[] }, url: string, override?: string): string {
  const tags = hashtags(a.tags).join(" ");
  const custom = override?.trim();
  if (network === "x") {
    // Budget: text + "\n\n" + url (counted as 23), then hashtags only if they still fit.
    const room = LIMITS.x - X_URL - 2;
    const lead = clip(custom || a.title, room);
    const withTags = tags && [...lead].length + 1 + [...tags].length <= room ? `${lead} ${tags}` : lead;
    return `${withTags}\n\n${url}`;
  }
  const body = custom || [a.title, a.summary].filter(Boolean).join("\n\n");
  return clip([body, tags].filter(Boolean).join("\n\n"), LIMITS[network]);
}

// ---- clients -----------------------------------------------------------------------------

type Fetch = typeof fetch;
const LINKEDIN_VERSION = "202606";
const GRAPH_VERSION = "v23.0";

async function failure(res: Response, label: string): Promise<never> {
  const text = await res.text().catch(() => "");
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { message?: string; detail?: string; title?: string; error?: { message?: string } | string; errors?: { message?: string }[] };
    msg = (typeof j.error === "object" ? j.error?.message : j.error) ?? j.errors?.[0]?.message ?? j.detail ?? j.message ?? j.title ?? msg;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) msg = `${label} rejected the credentials. ${msg}`.trim();
  throw new Error(`${label} (${res.status}): ${msg || res.statusText}`.slice(0, 400));
}

/** LinkedIn's "little text" format treats these characters as markup; escape them in plain text. */
const escapeLinkedIn = (s: string) => s.replace(/[\\(){}[\]<>@|~_*]/g, (c) => `\\${c}`);

async function postLinkedIn(f: Fetch, token: string, author: string, p: PostContent): Promise<PostResult> {
  const res = await f("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "linkedin-version": LINKEDIN_VERSION,
      "x-restli-protocol-version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      commentary: escapeLinkedIn(p.text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { article: { source: p.url, title: clip(p.title, 200), description: clip(p.description, 300) } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return failure(res, "LinkedIn");
  const id = res.headers.get("x-restli-id") ?? "";
  return { id, url: id ? `https://www.linkedin.com/feed/update/${id}` : null };
}

/** RFC 3986 percent-encoding (OAuth 1.0a requires it, unlike encodeURIComponent). */
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a `Authorization` header (HMAC-SHA1). A JSON body isn't part of the signature base. */
export function oauth1Header(
  method: string,
  url: string,
  c: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string },
  nonce = crypto.randomBytes(16).toString("hex"),
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const params: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  params.oauth_signature = crypto.createHmac("sha1", `${pct(c.apiSecret)}&${pct(c.accessSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(params).sort().map((k) => `${pct(k)}="${pct(params[k])}"`).join(", ");
}

async function postX(f: Fetch, c: NonNullable<SocialCreds["x"]>, p: PostContent): Promise<PostResult> {
  const url = "https://api.x.com/2/tweets";
  const res = await f(url, {
    method: "POST",
    headers: { authorization: oauth1Header("POST", url, c), "content-type": "application/json" },
    body: JSON.stringify({ text: p.text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return failure(res, "X");
  const id = ((await res.json().catch(() => null)) as { data?: { id?: string } } | null)?.data?.id ?? "";
  return { id, url: id ? `https://x.com/i/status/${id}` : null };
}

async function postFacebook(f: Fetch, token: string, pageId: string, p: PostContent): Promise<PostResult> {
  const res = await f(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/feed`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: p.text, link: p.url, access_token: token }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return failure(res, "Facebook");
  const id = ((await res.json().catch(() => null)) as { id?: string } | null)?.id ?? "";
  return { id, url: id ? `https://www.facebook.com/${id}` : null };
}

/** The real poster. Never retries: a retried POST could publish the same post twice. */
export const httpPoster =
  (f: Fetch = fetch): SocialPoster =>
  async (network, creds, ids, post) => {
    if (network === "linkedin") return postLinkedIn(f, creds.linkedin!.token, ids.linkedinAuthor, post);
    if (network === "x") return postX(f, creds.x!, post);
    return postFacebook(f, creds.facebook!.token, ids.facebookPageId, post);
  };
