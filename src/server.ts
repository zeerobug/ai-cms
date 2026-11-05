import { createApp } from "./app.js";
import { config } from "./config.js";

const { app, ai } = createApp();
app.listen(config.port, () => {
  console.log(`AICMS listening on http://localhost:${config.port}  (AI provider: ${ai.provider.name})`);
  if (ai.provider.name === "mock") console.log("No ANTHROPIC_API_KEY found: using the offline mock AI. Set AI_PROVIDER=anthropic to use Claude.");
});
