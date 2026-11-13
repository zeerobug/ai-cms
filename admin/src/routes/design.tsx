import { useRef, type ChangeEvent, type FormEvent } from "react";
import { Link, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { ThemeSummary } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { AiBadge, checked, field, useAction, useFlash, useTenant } from "../ui";

/** Same limit as the server (themes/palette.ts MAX_PALETTE_INPUT). */
const MAX_PALETTE_INPUT = 64 * 1024;

export const loader = ({ params, request }: LoaderFunctionArgs) => load<ThemeSummary[]>(`${tapi(params.tenant!)}/themes`, request);

export function Component() {
  const themes = useLoaderData() as ThemeSummary[];
  const tenant = useTenant();
  const canDesign = tenant.can["design.manage"];
  return (
    <>
      <h1>Design</h1>
      {canDesign && tenant.ai.enabled && <AiThemeForm themes={themes} />}
      {canDesign && <PaletteForm themes={themes} />}
      <h2>Themes</h2>
      <div className="themes">
        {themes.map((th) => <ThemeCard key={th.id} theme={th} canDesign={canDesign} />)}
      </div>
    </>
  );
}

function BaseThemeSelect({ themes }: { themes: ThemeSummary[] }) {
  return (
    <select name="baseThemeId" defaultValue="">
      <option value="">Current live theme</option>
      {themes.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
    </select>
  );
}

/** Palette input: paste values or load a file (read client-side into the textarea). */
function PaletteField({ hint, required = false }: { hint: string; required?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { fail } = useFlash();
  const loadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_PALETTE_INPUT) {
      e.target.value = "";
      return fail("Palette file is too large (64 KB max).");
    }
    ref.current!.value = await f.text();
  };
  return (
    <>
      <label>Color palette {!required && <span className="muted">(optional)</span>}</label>
      <textarea ref={ref} name="palette" required={required} placeholder={"#264653, #2a9d8f, #e9c46a, #f4a261, #e76f51\nor named:  primary: #0b6e99   background: #f3f8fb   accent: #f2a65a"} />
      <p className="muted" style={{ margin: ".3rem 0" }}>
        Or load a file: <input type="file" accept=".json,.css,.scss,.less,.gpl,.txt,.hex,text/plain,application/json" onChange={loadFile} />
        <br />Accepts hex / rgb() lists, CSS or SCSS variables, JSON, GIMP .gpl palettes and Coolors links. {hint}
      </p>
    </>
  );
}

function AiThemeForm({ themes }: { themes: ThemeSummary[] }) {
  const tenant = useTenant();
  const navigate = useNavigate();
  const [busy, run] = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    run(async () => {
      const { jobId } = await api<{ jobId: number }>(`${tapi(tenant.slug)}/ai/theme`, {
        body: { prompt: field(fd, "prompt"), baseThemeId: Number(field(fd, "baseThemeId")) || undefined, palette: field(fd, "palette"), apply: checked(fd, "apply"), heroImage: checked(fd, "heroImage") },
      });
      navigate(`/${tenant.slug}/jobs/${jobId}`);
    });
  };
  return (
    <form onSubmit={submit} className="panel ai">
      <h2 style={{ marginTop: 0 }}>✨ Describe the look you want</h2>
      <p className="muted">The AI designs a theme using the shared template system: colors, fonts, layout, hero, header and card styles.</p>
      <textarea name="prompt" required minLength={3} placeholder="e.g. A calm Japanese-inspired look with lots of whitespace, serif headings and a muted green palette. Magazine-style homepage." />
      <div className="row"><div><label>Start from</label><BaseThemeSelect themes={themes} /></div></div>
      <PaletteField hint="The AI builds the colors from it; colors named after a role (primary, background, …) are kept exactly." />
      {tenant.ai.imageProvider && <label className="check"><input type="checkbox" name="heroImage" /> Also generate a hero image for the home page</label>}
      <label className="check">
        <input type="checkbox" name="apply" disabled={!tenant.ai.canAutoApply} /> Apply to the live site immediately
        {!tenant.ai.canAutoApply && <span className="muted">(disabled by site settings — you can apply it manually after reviewing)</span>}
      </label>
      <button disabled={busy}>Design it</button>
    </form>
  );
}

function PaletteForm({ themes }: { themes: ThemeSummary[] }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    run(async () => {
      const { message } = await api<{ message: string }>(`${tapi(tenant.slug)}/themes/palette`, {
        body: { palette: field(fd, "palette"), name: field(fd, "name"), baseThemeId: Number(field(fd, "baseThemeId")) || undefined, apply: checked(fd, "apply") },
      });
      form.reset();
      await revalidate();
      notify(message);
    });
  };
  return (
    <form onSubmit={submit} className="panel">
      <h2 style={{ marginTop: 0 }}>🎨 Create a theme from a palette</h2>
      <p className="muted">Keeps the layout and fonts of the chosen theme and replaces its colors with your palette. No AI involved.</p>
      <div className="row">
        <div><label>Start from</label><BaseThemeSelect themes={themes} /></div>
        <div><label>New theme name <span className="muted">(optional)</span></label><input name="name" maxLength={80} /></div>
      </div>
      <PaletteField hint="" required />
      <label className="check"><input type="checkbox" name="apply" /> Apply to the live site immediately</label>
      <button disabled={busy}>Create theme</button>
    </form>
  );
}

function ThemeCard({ theme: th, canDesign }: { theme: ThemeSummary; canDesign: boolean }) {
  const tenant = useTenant();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const t = tapi(tenant.slug);
  const activate = () =>
    run(async () => {
      const { message } = await api<{ message: string }>(`${t}/themes/${th.id}/activate`, { method: "POST" });
      await revalidate();
      notify(message);
    });
  const remove = () => {
    if (!confirm("Delete theme?")) return;
    run(async () => {
      await api(`${t}/themes/${th.id}`, { method: "DELETE" });
      await revalidate();
      notify("Theme deleted.");
    });
  };
  return (
    <div className={`panel theme-card ${th.active ? "active" : ""}`}>
      <strong>{th.name}</strong> {th.active && <span className="badge b-published">live</span>} {th.source === "ai" && <AiBadge />}
      <div className="swatch">{th.swatch.map((c, i) => <span key={i} style={{ background: c }} />)}</div>
      <div className="muted">{th.description}</div>
      {th.prompt && <p className="muted">“{th.prompt.slice(0, 120)}”</p>}
      <div className="actions">
        <a className="btn sm sec" href={`/admin/${tenant.slug}/design/${th.id}/preview`} target="_blank" rel="noreferrer">Preview</a>
        {canDesign && (
          <>
            {!th.active && <button className="sm" onClick={activate} disabled={busy}>Apply</button>}
            <Link className="btn sm sec" to={`/${tenant.slug}/design/${th.id}`}>Edit</Link>
            {!th.active && <button className="sm danger" onClick={remove} disabled={busy}>Delete</button>}
          </>
        )}
      </div>
    </div>
  );
}
