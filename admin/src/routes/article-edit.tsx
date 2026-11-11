import { useRef, useState, type FormEvent, type RefObject } from "react";
import { useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { ArticleDetail } from "../../../src/web/admin-types";
import { api, load, tapi } from "../api";
import { ImagePicker, type PickedImage } from "../media";
import { AiBadge, field, MockWarning, StatusBadge, useAction, useFlash, useTenant } from "../ui";

export const loader = ({ params, request }: LoaderFunctionArgs) => load<ArticleDetail>(`${tapi(params.tenant!)}/articles/${params.id}`, request);

export function Component() {
  const a = useLoaderData() as ArticleDetail;
  const tenant = useTenant();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const { notify } = useFlash();
  const [busy, run] = useAction();
  const t = tapi(tenant.slug);
  const base = `/${tenant.slug}`;
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = {
      title: field(fd, "title"),
      slug: field(fd, "slug"),
      tags: field(fd, "tags"),
      status: field(fd, "status"),
      themeId: Number(field(fd, "themeId")) || null,
      summary: field(fd, "summary"),
      seoTitle: field(fd, "seoTitle"),
      seoDescription: field(fd, "seoDescription"),
      markdown: field(fd, "markdown"),
      imageUrl: field(fd, "imageUrl"),
      imageAlt: field(fd, "imageAlt"),
    };
    run(async () => {
      if (a.id === null) {
        const { id } = await api<{ id: number }>(`${t}/articles`, { body });
        navigate(`${base}/articles/${id}`, { replace: true, state: { flash: "Article created." } });
      } else {
        await api(`${t}/articles/${a.id}`, { method: "PUT", body });
        await revalidate();
        notify("Saved.");
      }
    });
  };
  const publish = () =>
    run(async () => {
      await api(`${t}/articles/${a.id}/status`, { body: { status: "published" } });
      await revalidate();
      notify("Status: published.");
    });
  const optimizeSeo = () =>
    run(async () => {
      const { jobId } = await api<{ jobId: number }>(`${t}/ai/seo`, { body: { target: "article", articleId: a.id } });
      navigate(`${base}/jobs/${jobId}`);
    });
  const remove = () => {
    if (!confirm("Delete this article?")) return;
    run(async () => {
      await api(`${t}/articles/${a.id}`, { method: "DELETE" });
      navigate(`${base}/articles`, { state: { flash: "Article deleted." } });
    });
  };

  return (
    <>
      <h1>
        {a.id === null ? "New article" : "Edit article"} {a.id !== null && <StatusBadge status={a.status} />} {a.source === "ai" && <AiBadge />}
      </h1>
      {a.source === "ai" && tenant.ai.provider === "mock" && <MockWarning />}
      {a.aiPrompt && <div className="panel muted"><strong>AI prompt:</strong> {a.aiPrompt}</div>}
      {a.id !== null && a.status !== "published" && tenant.can["article.publish"] && (
        <div className="panel">
          {a.status === "review" && "This article is waiting for review. "}
          <button onClick={publish} disabled={busy}>Approve & publish</button>
        </div>
      )}
      {/* key: reset the uncontrolled inputs when another article (or fresh data) loads */}
      <form key={`${a.id}-${a.slug}-${a.status}`} onSubmit={save} className="panel">
        <fieldset disabled={!a.editable}>
          <label>Title</label><input name="title" defaultValue={a.title} required />
          <div className="row">
            <div><label>Slug</label><input name="slug" defaultValue={a.slug} placeholder="auto from title" /></div>
            <div><label>Tags (comma separated)</label><input name="tags" defaultValue={a.tags.join(", ")} /></div>
            <div>
              <label>Status</label>
              <select name="status" defaultValue={a.statuses.includes(a.status) ? a.status : "review"}>
                {a.statuses.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label>Look</label>
              <select name="themeId" defaultValue={a.themeId ?? ""}>
                <option value="">Site theme</option>
                {a.themes.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
              </select>
            </div>
          </div>
          <CoverField initial={a.imageUrl ? { url: a.imageUrl, alt: a.imageAlt } : null} title={a.title} />
          <label>Summary</label><input name="summary" defaultValue={a.summary} />
          <div className="panel seo-fields">
            <strong>Search engines</strong>{" "}
            <span className="muted">(leave empty to use the title and summary{tenant.ai.enabled && tenant.ai.seoAuto ? "; the AI fills empty fields when the article is published" : ""})</span>
            <label>Search result title <span className="muted">(about 55 characters; the site name is added)</span></label>
            <CountedInput name="seoTitle" defaultValue={a.seoTitle} placeholder={a.title} max={60} />
            <label>Meta description <span className="muted">(120–155 characters)</span></label>
            <CountedInput name="seoDescription" defaultValue={a.seoDescription} placeholder={a.summary} max={155} />
            {a.id !== null && tenant.ai.enabled && (
              <p>
                <button type="button" className="sm" onClick={optimizeSeo} disabled={busy}>✨ Optimize SEO with AI</button>{" "}
                <span className="muted">Rewrites the search title, description, tags and image alt text{a.status !== "published" ? " and suggests a URL slug" : ""}. Save your changes first.</span>
              </p>
            )}
          </div>
          <label>Body <span className="muted">(Markdown: ## headings, lists, &gt; quotes, &gt; [!TIP] callouts, ```code```, ![alt](https://image))</span></label>
          <textarea ref={bodyRef} className="big" name="markdown" defaultValue={a.markdown} />
          <InsertImage target={bodyRef} />
          <p className="actions">
            <button disabled={busy}>Save</button>
            {a.id !== null && <a className="btn sec" href={`/admin${base}/articles/${a.id}/preview`} target="_blank" rel="noreferrer">Preview</a>}
          </p>
        </fieldset>
        {!a.editable && <p className="muted">You can't edit this article with your role.</p>}
      </form>
      {a.id !== null && tenant.can["article.delete"] && <button className="danger sm" onClick={remove} disabled={busy}>Delete article</button>}
    </>
  );
}

/** Text input with a live character count that turns red past `max`. */
function CountedInput({ name, defaultValue, placeholder, max }: { name: string; defaultValue: string; placeholder: string; max: number }) {
  const [n, setN] = useState(defaultValue.length);
  return (
    <div className="counted">
      <input name={name} defaultValue={defaultValue} placeholder={placeholder} maxLength={200} onChange={(e) => setN(e.target.value.length)} />
      <span className={n > max ? "count over" : "count"}>{n}/{max}</span>
    </div>
  );
}

/** Cover image: shown at the top of the article and on cards. Submitted via hidden inputs. */
function CoverField({ initial, title }: { initial: PickedImage | null; title: string }) {
  const [img, setImg] = useState(initial);
  return (
    <>
      <label>Cover image <span className="muted">(shown at the top of the article and on cards)</span></label>
      <input type="hidden" name="imageUrl" value={img?.url ?? ""} />
      {img && (
        <div className="cover-preview">
          <img src={img.url} alt="" />
          <div>
            <label>Alt text <span className="muted">(describe the image for screen readers)</span></label>
            {/* key: a newly picked image starts with its own alt text */}
            <input key={img.url} name="imageAlt" defaultValue={img.alt} maxLength={300} />
            <p><button type="button" className="sm sec" onClick={() => setImg(null)}>Remove cover</button></p>
          </div>
        </div>
      )}
      <ImagePicker onPick={setImg} suggestion={title ? `Editorial cover image for an article titled "${title}". No text in the image.` : ""} />
    </>
  );
}

/** Adds an image block (Markdown) at the cursor position of the body textarea. */
function InsertImage({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
  const [open, setOpen] = useState(false);
  const insert = ({ url, alt }: PickedImage) => {
    const ta = target.current!;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const md = `\n\n![${alt.replace(/[[\]\n]/g, " ").trim()}](${url})\n\n`;
    ta.value = ta.value.slice(0, start) + md + ta.value.slice(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + md.length;
    setOpen(false);
  };
  return open ? (
    <div className="panel" style={{ marginTop: ".5rem" }}>
      <strong>Insert an image into the body</strong>{" "}
      <button type="button" className="sm sec" onClick={() => setOpen(false)}>Cancel</button>
      <ImagePicker onPick={insert} />
    </div>
  ) : (
    <p><button type="button" className="sm sec" onClick={() => setOpen(true)}>＋ Insert image in body</button></p>
  );
}
