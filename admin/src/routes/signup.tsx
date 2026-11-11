import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { SessionInfo } from "../../../src/web/admin-types";
import { api, setSession } from "../api";
import { field, useAction } from "../ui";

export function Component() {
  const navigate = useNavigate();
  const [busy, run] = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(["name", "email", "password", "site", "slug"].map((k) => [k, field(fd, k)]));
    run(async () => {
      const res = await api<SessionInfo & { site: string }>("/signup", { body });
      setSession(res);
      navigate(`/${res.site}`, { replace: true, state: { flash: "Your site is ready. Ask the AI to write your first article!" } });
    });
  };
  return (
    <div className="panel" style={{ maxWidth: 480, margin: "3rem auto" }}>
      <h1>Create your site</h1>
      <form onSubmit={submit}>
        <label>Your name</label><input name="name" required />
        <label>Email</label><input type="email" name="email" required />
        <label>Password (min 8 chars)</label><input type="password" name="password" minLength={8} required />
        <label>Site name</label><input name="site" required />
        <label>Site address (slug)</label><input name="slug" pattern="[a-z0-9-]+" placeholder="my-site" required />
        <p><button disabled={busy}>Create site</button></p>
      </form>
      <p className="muted">Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
