import { useRef, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { ThemeDetail } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { ImagePicker } from "../media";
import { field, useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<ThemeDetail>(`${tapi(params.tenant!)}/themes/${params.id}`, request);

export function Component() {
  const theme = useLoaderData() as ThemeDetail;
  const tenant = useTenant();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const { notify, fail } = useFlash();
  const [busy, run] = useAction();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [, setVersion] = useState(0);
  const json = JSON.stringify(theme.spec, null, 2);

  const save = (asCopy: boolean) => {
    let spec: unknown;
    try {
      spec = JSON.parse(ref.current!.value);
    } catch {
      return fail("That isn't valid JSON.");
    }
    run(async () => {
      const res = await api<{ id: number; message: string }>(`${tapi(tenant.slug)}/themes/${theme.id}`, { method: "PUT", body: { spec, asCopy } });
      if (asCopy) return navigate(`/${tenant.slug}/design/${res.id}`, { state: { flash: res.message } });
      await revalidate();
      setVersion((v) => v + 1); // show the normalized spec the server saved
      notify(res.message);
    });
  };

  return (
    <>
      <h1>Edit theme: {theme.name}</h1>
      <Logo theme={theme} onChange={() => setVersion((v) => v + 1)} />
      <HeroText theme={theme} onChange={() => setVersion((v) => v + 1)} />
      <HeroImage theme={theme} onChange={() => setVersion((v) => v + 1)} />
      <div className="panel">
        <p className="muted">Every theme is a JSON spec rendered by the same template engine. Invalid values are clamped or reset to defaults on save.</p>
        <textarea key={`${theme.id}-${json}`} ref={ref} className="big" defaultValue={json} />
        <p className="actions">
          <button onClick={() => save(false)} disabled={busy}>Save</button>
          <button className="sec" onClick={() => save(true)} disabled={busy}>Save as copy</button>
          <a className="btn sec" href={`/admin/${tenant.slug}/design/${theme.id}/preview`} target="_blank" rel="noreferrer">Preview</a>
        </p>
      </div>
    </>
  );
}

/** Hero banner image: upload, generate or pick one; saved to the theme right away. */
function HeroImage({ theme, onChange }: { theme: ThemeDetail; onChange: () => void }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const set = (url: string | null) =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/themes/${theme.id}/hero-image`, { method: "PUT", body: { url } });
      await revalidate();
      onChange(); // refresh the JSON below
      notify(message);
    });
  const suggestion = `Wide atmospheric banner image for the website "${tenant.name}"${tenant.tagline ? ` (${tenant.tagline})` : ""}. No text in the image.`;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Hero image</h2>
      <p className="muted">The banner at the top of the home page. Setting an image turns the hero on with the “image” style.</p>
      {theme.heroImageUrl ? (
        <div className="cover-preview">
          <img src={theme.heroImageUrl} alt="" />
          <div><button className="sm sec" onClick={() => set(null)} disabled={busy}>Remove hero image</button></div>
        </div>
      ) : (
        <p className="muted">No hero image yet.</p>
      )}
      <ImagePicker onPick={(img) => set(img.url)} suggestion={suggestion} />
    </div>
  );
}

/** Site logo shown in the header in place of the site name; saved to the theme right away. */
function Logo({ theme, onChange }: { theme: ThemeDetail; onChange: () => void }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const set = (url: string | null) =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/themes/${theme.id}/logo`, { method: "PUT", body: { url } });
      await revalidate();
      onChange();
      notify(message);
    });
  const suggestion = `Simple logo mark for the website "${tenant.name}"${tenant.tagline ? ` (${tenant.tagline})` : ""}. Flat, no background, no text.`;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Logo</h2>
      <p className="muted">Shown in the site header instead of the site name (the name stays as the image’s alt text). PNG, JPEG, WebP or GIF.</p>
      {theme.logoUrl ? (
        <div className="cover-preview">
          <img src={theme.logoUrl} alt="Logo" style={{ maxHeight: 80, width: "auto" }} />
          <div><button className="sm sec" onClick={() => set(null)} disabled={busy}>Remove logo</button></div>
        </div>
      ) : (
        <p className="muted">No logo yet.</p>
      )}
      <ImagePicker onPick={(img) => set(img.url)} suggestion={suggestion} />
    </div>
  );
}

/** Hero headline, subtitle and call-to-action button; saved to the theme right away. */
function HeroText({ theme, onChange }: { theme: ThemeDetail; onChange: () => void }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const h = theme.hero;
  const save = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = { title: field(fd, "title"), subtitle: field(fd, "subtitle"), ctaLabel: field(fd, "ctaLabel"), ctaHref: field(fd, "ctaHref"), enabled: true };
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/themes/${theme.id}/hero-text`, { method: "PUT", body });
      await revalidate();
      onChange();
      notify(message);
    });
  };
  return (
    <form className="panel" onSubmit={save} key={`${h.title}|${h.subtitle}|${h.ctaLabel}|${h.ctaHref}`}>
      <h2 style={{ marginTop: 0 }}>Hero text and button</h2>
      <p className="muted">Leave the headline or subtitle empty to use the site name and tagline. The button shows only when it has both a label and a link. Saving turns the hero on.</p>
      <label>Headline<input name="title" maxLength={140} defaultValue={h.title} placeholder={tenant.name} /></label>
      <label>Subtitle<textarea name="subtitle" maxLength={300} rows={2} defaultValue={h.subtitle} placeholder={tenant.tagline} /></label>
      <label>Button label<input name="ctaLabel" maxLength={40} defaultValue={h.ctaLabel} placeholder="Read the latest" /></label>
      <label>Button link<input name="ctaHref" maxLength={300} defaultValue={h.ctaHref} placeholder="/tag/news or https://…" /></label>
      <p className="actions"><button disabled={busy}>Save hero text</button></p>
    </form>
  );
}
