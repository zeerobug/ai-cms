/**
 * Images (uploaded or AI-generated) are stored per tenant in the `media` table and served at
 * `/media/<tenant-slug>/<file>`, where <file> is a random key plus extension. Only raster formats
 * identified by their magic bytes are accepted — never SVG (it can carry scripts).
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageAspect = "landscape" | "square" | "portrait";
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["landscape", "square", "portrait"];

export interface ImageType {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  ext: "png" | "jpg" | "webp" | "gif";
}

/** Detect the image format from the file's first bytes (the declared Content-Type is not trusted). */
export function sniffImage(b: Uint8Array): ImageType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return { mime: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { mime: "image/gif", ext: "gif" };
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export const mediaUrl = (tenantSlug: string, file: string) => `/media/${tenantSlug}/${file}`;

/** `file` part of a media URL: 16 base64url chars + extension. */
export const MEDIA_FILE_RE = /^[A-Za-z0-9_-]{16}\.(png|jpg|webp|gif)$/;
const MEDIA_PATH_RE = /^\/media\/[a-z0-9-]+\/[A-Za-z0-9_-]{16}\.(png|jpg|webp|gif)$/;
/** No quotes, parentheses, backslashes or whitespace: the URL is also used inside CSS url(). */
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+$/;

/** Image URLs allowed in themes and article covers: https URLs or this CMS's own media paths. */
export function isImageUrl(u: unknown): u is string {
  return (
    typeof u === "string" &&
    u.length <= 500 &&
    URL_CHARS_RE.test(u) &&
    (/^https:\/\/[^/]/.test(u) || MEDIA_PATH_RE.test(u))
  );
}
