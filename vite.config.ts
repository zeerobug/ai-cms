import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// React admin: source in admin/, served under /admin, built to dist/admin.
// In dev it runs inside the Express server (src/web/admin-spa.ts), so there's a single port.
export default defineConfig({
  root: "admin",
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/admin", emptyOutDir: true },
});
