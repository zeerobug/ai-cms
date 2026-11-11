import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { ImageAspect, ImageGenerateInput, MediaItem } from "../../src/web/admin-types";
import { api, tapi, upload } from "./api";
import { useAction, useFlash, useTenant } from "./ui";

/** Same limit as the server (content/media.ts MAX_IMAGE_BYTES). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export type PickedImage = { url: string; alt: string };

/** "my-summer_photo.jpg" → "my summer photo" */
const altFromFileName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 300);

/**
 * Gets an image for the caller: upload a file, generate one with AI, or reuse one from the site's
 * media library. Every image ends up in the library; `onPick` receives its URL and alt text.
 * Safe to place inside a <form>: its buttons never submit it.
 */
export function ImagePicker({
  onPick,
  aspect = "landscape",
  suggestion = "",
}: {
  onPick: (img: PickedImage) => void;
  aspect?: ImageAspect;
  /** Starting prompt for AI generation. */
  suggestion?: string;
}) {
  const tenant = useTenant();
  const { notify, fail } = useFlash();
  const [busy, run] = useAction();
  const [prompt, setPrompt] = useState(suggestion);
  const [library, setLibrary] = useState<MediaItem[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const t = tapi(tenant.slug);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) return fail(`That file is too large (${MAX_IMAGE_BYTES / 1024 / 1024} MB max).`);
    run(async () => {
      const m = await upload<MediaItem>(`${t}/media`, file, { alt: altFromFileName(file.name) });
      onPick({ url: m.url, alt: m.alt });
      setLibrary(null);
      notify("Image uploaded.");
    });
  };

  const generate = () => {
    if (prompt.trim().length < 3) return fail("Describe the image first.");
    setGenerating(true);
    run(async () => {
      const body: ImageGenerateInput = { prompt, aspect };
      const m = await api<MediaItem>(`${t}/media/generate`, { body });
      onPick({ url: m.url, alt: m.alt });
      setLibrary(null);
      notify("Image generated.");
    }).finally(() => setGenerating(false));
  };
  const onPromptKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // don't submit the surrounding form
    generate();
  };

  const toggleLibrary = () => (library ? setLibrary(null) : run(async () => setLibrary(await api<MediaItem[]>(`${t}/media`))));
  const remove = (m: MediaItem) => {
    if (!confirm("Delete this image from the library? Pages that use it will show a broken image.")) return;
    run(async () => {
      const { message } = await api<{ message: string }>(`${t}/media/${m.id}`, { method: "DELETE" });
      setLibrary((l) => l && l.filter((x) => x.id !== m.id));
      notify(message);
    });
  };

  return (
    <div className="picker">
      <div className="actions">
        <label className={`btn sm sec file ${busy ? "disabled" : ""}`}>
          Upload image…
          <input type="file" accept={ACCEPT} onChange={onFile} disabled={busy} hidden />
        </label>
        <button type="button" className="sm sec" onClick={toggleLibrary} disabled={busy}>
          {library ? "Hide library" : "Choose from library"}
        </button>
        {busy && <span className="spinner" />}
      </div>
      {tenant.ai.enabled &&
        (tenant.ai.imageProvider ? (
          <div className="gen">
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onPromptKey} maxLength={2000} placeholder="Describe an image for the AI to create…" />
            <button type="button" className="sm" onClick={generate} disabled={busy}>✨ Generate</button>
          </div>
        ) : (
          <p className="muted">AI images need an image-capable provider (OpenAI); Claude only writes text. Choose OpenAI in Settings, or upload an image.</p>
        ))}
      {generating && <p className="muted">Generating an image can take up to a minute.</p>}
      {library && (
        <div className="media-grid">
          {library.map((m) => (
            <div key={m.id} className="media-item">
              <button type="button" onClick={() => (onPick({ url: m.url, alt: m.alt }), setLibrary(null))} title={m.prompt ?? m.alt}>
                <img src={m.url} alt={m.alt} loading="lazy" />
              </button>
              {m.source === "ai" && <span className="badge b-ai">AI</span>}
              {tenant.can["media.delete"] && (
                <button type="button" className="del" onClick={() => remove(m)} title="Delete image" disabled={busy}>×</button>
              )}
            </div>
          ))}
          {!library.length && <p className="muted">No images yet.</p>}
        </div>
      )}
    </div>
  );
}
