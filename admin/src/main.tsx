import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, NavLink, Outlet, redirect, useMatch, useNavigate, useNavigation, type LoaderFunctionArgs } from "react-router";
import { RouterProvider } from "react-router/dom";
import type { SessionInfo } from "../../src/web/admin-types";
import { api, getSession, setSession, useSession } from "./api";
import { ErrorPage, FlashProvider, NotFound, PageLoading, Toaster, useTenant } from "./ui";
import "./styles.css";

/**
 * Routes. Only this file (the shell) is in the initial bundle; every page is a separate chunk
 * loaded on first navigation via `lazy` (each route module exports `Component` and usually `loader`).
 */
const router = createBrowserRouter(
  [
    {
      id: "root",
      path: "/",
      loader: rootLoader,
      Component: Root,
      ErrorBoundary: RootError,
      HydrateFallback: PageLoading,
      children: [
        { path: "login", lazy: () => import("./routes/login") },
        { path: "signup", lazy: () => import("./routes/signup") },
        { index: true, lazy: () => import("./routes/sites") },
        {
          id: "tenant",
          path: ":tenant",
          lazy: () => import("./routes/tenant"),
          ErrorBoundary: ErrorPage,
          children: [
            { index: true, lazy: () => import("./routes/dashboard") },
            { path: "articles", lazy: () => import("./routes/articles") },
            { path: "articles/:id", lazy: () => import("./routes/article-edit") },
            { path: "jobs/:id", lazy: () => import("./routes/job") },
            { path: "design", lazy: () => import("./routes/design") },
            { path: "design/:id", lazy: () => import("./routes/theme-edit") },
            { path: "publish", lazy: () => import("./routes/publish") },
            { path: "social", lazy: () => import("./routes/social") },
            { path: "settings", lazy: () => import("./routes/settings") },
          ],
        },
        { path: "*", Component: NotFound },
      ],
    },
  ],
  { basename: "/admin" },
);

/** Loads the session once; anonymous users can only see /login and /signup. */
async function rootLoader({ request }: LoaderFunctionArgs) {
  if (!getSession().csrf) setSession(await api<SessionInfo>("/session", { signal: request.signal }));
  const path = new URL(request.url).pathname.replace(/^\/admin/, "") || "/";
  const publicPage = path === "/login" || path === "/signup";
  if (!getSession().user && !publicPage) throw redirect("/login");
  if (getSession().user && publicPage) throw redirect("/");
  return null;
}

function Root() {
  const navigation = useNavigation();
  return (
    <FlashProvider>
      {navigation.state !== "idle" && <div className="loading-bar" />}
      <Header />
      <main>
        <Outlet />
      </main>
      <Toaster />
    </FlashProvider>
  );
}

function RootError() {
  return (
    <main>
      <ErrorPage />
    </main>
  );
}

function Header() {
  const { user } = useSession();
  const inTenant = useMatch("/:tenant/*");
  const navigate = useNavigate();
  const slug = inTenant && !["login", "signup"].includes(inTenant.params.tenant!) ? inTenant.params.tenant! : null;
  async function logout() {
    setSession(await api<SessionInfo>("/logout", { method: "POST" }));
    navigate("/login");
  }
  return (
    <header className="top">
      <Link className="logo" to="/">AICMS</Link>
      {user && slug && <TenantNav slug={slug} />}
      <span className="sp" />
      {user && (
        <>
          <span className="muted">{user.email}</span>
          <button className="sm sec" onClick={logout}>Log out</button>
        </>
      )}
    </header>
  );
}

/** Rendered only inside a tenant route, where the "tenant" loader data exists. */
function TenantNav({ slug }: { slug: string }) {
  const tenant = useTenant();
  if (!tenant) return null;
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "on" : "");
  return (
    <>
      <strong>{tenant.name}</strong>
      <NavLink to={`/${slug}`} end className={cls}>Dashboard</NavLink>
      <NavLink to={`/${slug}/articles`} className={cls}>Articles</NavLink>
      <NavLink to={`/${slug}/design`} className={cls}>Design</NavLink>
      {tenant.can["article.publish"] && <NavLink to={`/${slug}/publish`} className={cls}>Publish</NavLink>}
      {tenant.can["article.publish"] && <NavLink to={`/${slug}/social`} className={cls}>Social</NavLink>}
      {tenant.can["settings.manage"] && <NavLink to={`/${slug}/settings`} className={cls}>Settings</NavLink>}
      <a href={`/s/${slug}`} target="_blank" rel="noreferrer">View site ↗</a>
      <span className="muted ml-1 rounded-full bg-white/10 px-2 py-0.5 text-xs capitalize">{tenant.role}</span>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
