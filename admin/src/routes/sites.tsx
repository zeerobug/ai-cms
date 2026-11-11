import type { FormEvent } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { SiteSummary } from "../../../src/web/admin-types";
import { api, load } from "../api";
import { field, useAction } from "../ui";

export const loader = ({ request }: LoaderFunctionArgs) => load<SiteSummary[]>("/sites", request);

export function Component() {
  const sites = useLoaderData() as SiteSummary[];
  const navigate = useNavigate();
  const [busy, run] = useAction();
  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    run(async () => {
      const { slug } = await api<{ slug: string }>("/sites", { body: { name: field(fd, "name"), slug: field(fd, "slug") } });
      navigate(`/${slug}`, { state: { flash: "Site created." } });
    });
  };
  return (
    <>
      <h1>Your sites</h1>
      <table>
        <thead><tr><th>Site</th><th>Role</th><th></th></tr></thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.slug}>
              <td><Link to={`/${s.slug}`}>{s.name}</Link> <span className="muted">/{s.slug}</span></td>
              <td>{s.role}</td>
              <td><a href={`/s/${s.slug}`} target="_blank" rel="noreferrer">View ↗</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Create another site</h2>
      <form onSubmit={create} className="panel">
        <div className="row">
          <div><label>Site name</label><input name="name" required /></div>
          <div><label>Slug</label><input name="slug" pattern="[a-z0-9-]+" required /></div>
        </div>
        <p><button disabled={busy}>Create</button></p>
      </form>
    </>
  );
}
