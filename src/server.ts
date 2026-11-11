import { createApp } from "./app.js";
import { config } from "./config.js";
import { adminSpa } from "./web/admin-spa.js";

const dev = process.env.NODE_ENV !== "production";
const { app, ai } = createApp({ adminUi: await adminSpa({ dev }) });
app.listen(config.port, () => {
  console.log(`AICMS listening on http://localhost:${config.port}/admin  (AI provider: ${ai.provider.name}, admin UI: ${dev ? "vite dev" : "built"})`);
  if (ai.provider.name === "mock") console.log("No ANTHROPIC_API_KEY or OPENAI_API_KEY found: using the offline mock AI. Set one (or AI_PROVIDER) to use a real model.");
  if (config.secretIsEphemeral) console.log("APP_SECRET is not set: sessions' CSRF tokens and tenants' stored AI API keys won't survive a restart.");
});
