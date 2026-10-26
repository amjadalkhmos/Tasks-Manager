import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { startReminderJob } from "./reminders.js";
import { createAnthropicAi } from "./ai.js";
import { createGoogleApi, googleConfigFromEnv } from "./google.js";

const secret = process.env.JWT_SECRET;
if (!secret && process.env.NODE_ENV === "production") throw new Error("JWT_SECRET must be set in production");

const db = openDb(process.env.DB_FILE ?? "tasks.db");
const googleConfig = googleConfigFromEnv(process.env);
if (googleConfig && process.env.NODE_ENV === "production" && !process.env.TOKEN_ENC_KEY)
  throw new Error("TOKEN_ENC_KEY (base64, 32 bytes) must be set when Google integration is enabled in production");

// AI features switch on when an Anthropic key is present (or AI_ENABLED=1 for profile-based credentials).
const aiEnabled = !!process.env.ANTHROPIC_API_KEY || process.env.AI_ENABLED === "1";
const app = createApp(db, secret ?? "dev-only-secret", {
  ai: aiEnabled ? createAnthropicAi(process.env.AI_MODEL ?? "claude-sonnet-5-5") : null,
  google: googleConfig ? createGoogleApi(googleConfig) : null,
  tokenEncKey: process.env.TOKEN_ENC_KEY,
});

// Serve the built frontend when present (single-host deployment).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      // The service worker and manifest must revalidate so updates reach people promptly.
      setHeaders: (res, file) => /(sw\.js|manifest\.webmanifest)$/.test(file) && res.setHeader("Cache-Control", "no-cache"),
    }),
  );
  // SPA fallback (Express 5 rejects a bare "*" route, so use a middleware).
  app.use((req, res, next) =>
    req.method === "GET" && !req.path.startsWith("/api") ? res.sendFile(path.join(webDist, "index.html")) : next(),
  );
}

startReminderJob(db);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
