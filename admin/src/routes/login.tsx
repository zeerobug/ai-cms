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
    run(async () => {
      setSession(await api<SessionInfo>("/login", { body: { email: field(fd, "email"), password: field(fd, "password") } }));
      navigate("/", { replace: true });
    });
  };
  return (
    <div className="panel" style={{ maxWidth: 420, margin: "3rem auto" }}>
      <h1>Log in</h1>
      <form onSubmit={submit}>
        <label>Email</label>
        <input type="email" name="email" required autoFocus />
        <label>Password</label>
        <input type="password" name="password" required />
        <p><button disabled={busy}>Log in</button></p>
      </form>
      <p className="muted">No account? <Link to="/signup">Create a site</Link></p>
    </div>
  );
}
