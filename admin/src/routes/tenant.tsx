import { Outlet, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from "react-router";
import type { TenantInfo } from "../../../src/web/admin-types";
import { load, tapi } from "../api";

/** Layout for /:tenant/*. Its data (role, permissions, AI policy) is read via `useTenant()`. */
export const loader = ({ params, request }: LoaderFunctionArgs) => load<TenantInfo>(tapi(params.tenant!), request);

// Refetch when switching sites, or on an explicit revalidate() (same URL, e.g. after saving
// settings); plain navigation within a site keeps the cached tenant data.
export const shouldRevalidate = ({ currentParams, nextParams, currentUrl, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentParams.tenant !== nextParams.tenant || currentUrl.href === nextUrl.href;

export function Component() {
  return <Outlet />;
}
