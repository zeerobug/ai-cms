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

export interface PostImage {
  data: Uint8Array;
  mime: string;
}
export interface PostContent {
  /** Picture to attach (only X uses it for now; posting continues without it if the upload fails). */
  image?: PostImage;
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
  /** Something worth showing even though the post went out (e.g. the picture couldn't be attached). */
  note?: string;
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

/** The question every X post ends with when no better one is available. */
export const FALLBACK_QUESTION = "What's your take?";

/** X's weighted length: most Latin text counts 1 per character; "…", CJK, emoji and the like count 2. */
export function xLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247) ? 1 : 2;
  }
  return n;
}

/** Cuts `s` to at most `max` weighted characters, ending in "…" (which weighs 2) when something was cut. */
function clipX(s: string, max: number): string {
  if (xLength(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (xLength(out + ch) > max - 2) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

/**
 * The X post: a hook, the link, then a question, so the post ends by inviting a reply. `copy` is the
 * AI's hook + question; without it the article title is the hook. Fitted to 280 weighted characters
 * (the link counts 23); hashtags are reserved first, the hook is clipped to fit.
 */
export function composeXPost(a: { title: string; tags: string[] }, url: string, copy?: { hook: string; question: string } | null): string {
  const room = LIMITS.x - X_URL - 4; // two blank-line separators
  let question = copy?.question.trim() || FALLBACK_QUESTION;
  if (!question.endsWith("?")) question = question.replace(/[.!…\s]+$/, "") + "?";
  question = clipX(question, Math.floor(room / 2));
  if (!question.endsWith("?")) question = question.slice(0, -1).trimEnd() + "?";
  // Hashtags are reserved first (up to 3, at most 45 characters): the hook is shortened to make room.
  const tagList = hashtags(a.tags).slice(0, 3);
  while (tagList.length && xLength(tagList.join(" ")) > 45) tagList.pop();
  const tags = tagList.join(" ");
  const tagRoom = tags ? xLength(tags) + 1 : 0;
  let hook = clipX((copy?.hook.trim() || a.title).replace(/\s+/g, " "), room - xLength(question) - tagRoom);
  if (tags) hook = `${hook} ${tags}`;
  return `${hook}\n\n${url}\n\n${question}`;
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

/** Uploads a picture and returns its media id. A multipart body isn't part of the OAuth 1.0a signature. */
async function uploadXImage(f: Fetch, c: NonNullable<SocialCreds["x"]>, img: PostImage): Promise<string> {
  const url = "https://api.x.com/2/media/upload";
  const form = new FormData();
  form.set("media_category", "tweet_image");
  form.set("media_type", img.mime);
  form.set("media", new Blob([img.data as BlobPart], { type: img.mime }), "image");
  const res = await f(url, { method: "POST", headers: { authorization: oauth1Header("POST", url, c) }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return failure(res, "X media upload");
  const j = (await res.json().catch(() => null)) as { data?: { id?: string }; media_id_string?: string } | null;
  const id = j?.data?.id ?? j?.media_id_string;
  if (!id) throw new Error("X media upload returned no media id.");
  return id;
}

async function postX(f: Fetch, c: NonNullable<SocialCreds["x"]>, p: PostContent): Promise<PostResult> {
  const url = "https://api.x.com/2/tweets";
  let mediaId: string | null = null;
  let note: string | undefined;
  if (p.image) {
    try {
      mediaId = await uploadXImage(f, c, p.image);
    } catch (e) {
      // Post the text anyway, but say so: the person should know the picture is missing.
      note = `Posted without the image: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
      console.error("[social] X image skipped:", note);
    }
  }
  const res = await f(url, {
    method: "POST",
    headers: { authorization: oauth1Header("POST", url, c), "content-type": "application/json" },
    body: JSON.stringify({ text: p.text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return failure(res, "X");
  const id = ((await res.json().catch(() => null)) as { data?: { id?: string } } | null)?.data?.id ?? "";
  return { id, url: id ? `https://x.com/i/status/${id}` : null, note };
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
