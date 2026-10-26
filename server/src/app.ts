import Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { DB } from "./db.js";
import { COOKIE, requireAuth, signToken, type AuthedRequest } from "./auth.js";
import { HttpError } from "./http-error.js";
import { registerExtras } from "./extras.js";
import { registerDataIo } from "./dataio.js";
import { registerAi, type AiClient } from "./ai.js";
import { registerGoogle, type GoogleApi } from "./google.js";
import { registerTasks } from "./tasks.js";
import { registerCollab } from "./collab.js";
import { displayNameSql } from "./events.js";
import { makeKey } from "./secrets.js";

const credentials = z.object({ email: z.string().email(), password: z.string().min(8) });
const registration = credentials.extend({ name: z.string().trim().max(60).optional() });

export interface AppOptions {
  ai?: AiClient | null;
  google?: GoogleApi | null;
  /** base64 32-byte key for encrypting OAuth tokens; defaults to a key derived from the JWT secret */
  tokenEncKey?: string;
}

export function createApp(db: DB, secret: string, options: AppOptions = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());
  const auth = requireAuth(secret);
  const uid = (req: Request) => (req as AuthedRequest).userId;

  const setSession = (res: Response, userId: number) =>
    res.cookie(COOKIE, signToken(userId, secret), {
      httpOnly: true,
      sameSite: "lax",
      // Secure cookies only travel over HTTPS (browsers exempt localhost). Set COOKIE_SECURE=false to run over plain HTTP,
      // e.g. on a home network without a TLS proxy.
      secure: (process.env.COOKIE_SECURE ?? String(process.env.NODE_ENV === "production")) === "true",
      maxAge: 7 * 24 * 3600 * 1000,
    });

  const profile = (userId: number) =>
    db.prepare(`SELECT u.id, u.email, ${displayNameSql("u")} AS name FROM users u WHERE u.id = ?`).get(userId) as { id: number; email: string; name: string };

  // ---------- auth ----------
  app.post("/api/auth/register", (req, res) => {
    const { email, password, name } = registration.parse(req.body);
    const lower = email.toLowerCase();
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(lower)) throw new HttpError(409, "Email already registered");
    const info = db
      .prepare("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)")
      .run(lower, bcrypt.hashSync(password, Number(process.env.BCRYPT_ROUNDS ?? 10)), name || null);
    setSession(res, Number(info.lastInsertRowid));
    res.status(201).json(profile(Number(info.lastInsertRowid)));
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const lower = email.toLowerCase();
    const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(lower) as
      | { id: number; password_hash: string }
      | undefined;
    if (!user || !bcrypt.compareSync(password, user.password_hash)) throw new HttpError(401, "Invalid credentials");
    setSession(res, user.id);
    res.json(profile(user.id));
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE).status(204).end();
  });

  app.get("/api/auth/me", auth, (req, res) => {
    res.json(profile(uid(req)));
  });

  app.patch("/api/auth/me", auth, (req, res) => {
    const { name } = z.object({ name: z.string().trim().max(60) }).parse(req.body);
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name || null, uid(req));
    res.json(profile(uid(req)));
  });

  const { getTask } = registerTasks(app, { db, auth, uid });
  registerExtras(app, { db, auth, uid, getTask });
  registerDataIo(app, { db, auth, uid });
  registerAi(app, { db, auth, uid, ai: options.ai ?? null });
  registerGoogle(app, { db, auth, uid, api: options.google ?? null, secret, key: makeKey(options.tokenEncKey, secret) });
  registerCollab(app, { db, auth, uid });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: "Validation failed", issues: err.issues });
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    // body-parser errors (malformed or oversized JSON) carry their own 4xx status
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500)
      return void res.status(status).json({ error: status === 413 ? "Request body too large" : "Invalid request body" });
    if (err instanceof Anthropic.RateLimitError) return void res.status(429).json({ error: "The AI service is busy — try again shortly" });
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return void res.status(502).json({ error: "The AI service returned an error" });
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
