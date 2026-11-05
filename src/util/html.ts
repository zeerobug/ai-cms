export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only allow http(s), mailto, root-relative and fragment URLs. */
export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^\/(?!\/)/.test(u) || u.startsWith("#")) return u;
  return null;
}

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export class Raw {
  constructor(public value: string) {}
  toString() {
    return this.value;
  }
}
export const raw = (s: string) => new Raw(s);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) out += interp(values[i]);
  });
  return new Raw(out);
}

function interp(v: unknown): string {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(interp).join("");
  return escapeHtml(v);
}
