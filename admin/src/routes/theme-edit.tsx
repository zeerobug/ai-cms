import { useRef, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { ThemeDetail } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { ImagePicker } from "../media";
import { useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<ThemeDetail>(`${tapi(params.tenant!)}/themes/${params.id}`, request);

export function Component() {
  const theme = useLoaderData() as ThemeDetail;
  const tenant = useTenant();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const { notify, fail } = useFlash();
  const [busy, run] = useAction();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [version, setVersion] = useState(0);

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
      <HeroImage theme={theme} onChange={() => setVersion((v) => v + 1)} />
      <div className="panel">
        <p className="muted">Every theme is a JSON spec rendered by the same template engine. Invalid values are clamped or reset to defaults on save.</p>
        <textarea key={`${theme.id}-${version}`} ref={ref} className="big" defaultValue={JSON.stringify(theme.spec, null, 2)} />
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
