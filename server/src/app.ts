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
import { registerIntake } from "./intake.js";
import { registerMeetings } from "./meetings.js";
import { registerProjectManagement } from "./pm.js";
import { registerStatuses } from "./statuses.js";
import { registerSalesAccounts } from "./sales-accounts.js";
import { registerSalesDeals } from "./sales-deals.js";
import { registerSalesLeads } from "./sales-leads.js";
import { registerSalesSetup } from "./sales-setup.js";
import { displayName } from "./dialect.js";
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
  // Behind a reverse proxy (Railway, nginx…) set TRUST_PROXY=1 so rate limits see each visitor's address, not the proxy's.
  if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
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
    db.get<{ id: number; email: string; name: string }>(`SELECT u.id, u.email, ${displayName(db.dialect, "u")} AS name FROM users u WHERE u.id = ?`, userId);

  // ---------- auth ----------
  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name } = registration.parse(req.body);
    const lower = email.toLowerCase();
    if (await db.get("SELECT 1 FROM users WHERE email = ?", lower)) throw new HttpError(409, "Email already registered");
    const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS ?? 10));
    let userId: number;
    try {
      userId = await db.insert("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)", lower, hash, name || null);
    } catch (e) {
      // Two sign-ups with the same address can pass the check above together; the unique index settles it.
      if (/unique|duplicate/i.test(e instanceof Error ? e.message : "")) throw new HttpError(409, "Email already registered");
      throw e;
    }
    setSession(res, userId);
    res.status(201).json(await profile(userId));
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const lower = email.toLowerCase();
    const user = await db.get<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", lower);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new HttpError(401, "Invalid credentials");
    setSession(res, user.id);
    res.json(await profile(user.id));
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE).status(204).end();
  });

  app.get("/api/auth/me", auth, async (req, res) => {
    const me = await profile(uid(req));
    if (!me) return void res.status(401).json({ error: "Not authenticated" }); // the account was deleted
    res.json(me);
  });

  app.patch("/api/auth/me", auth, async (req, res) => {
    const { name } = z.object({ name: z.string().trim().max(60) }).parse(req.body);
    await db.run("UPDATE users SET name = ? WHERE id = ?", name || null, uid(req));
    res.json(await profile(uid(req)));
  });

  const { getTask } = registerTasks(app, { db, auth, uid });
  registerExtras(app, { db, auth, uid, getTask });
  registerDataIo(app, { db, auth, uid });
  registerAi(app, { db, auth, uid, ai: options.ai ?? null });
  registerGoogle(app, { db, auth, uid, api: options.google ?? null, secret, key: makeKey(options.tokenEncKey, secret) });
  registerCollab(app, { db, auth, uid });
  registerIntake(app, { db, auth, uid });
  registerMeetings(app, { db, auth, uid });
  registerStatuses(app, { db, auth, uid });
  registerProjectManagement(app, { db, auth, uid });
  registerSalesSetup(app, { db, auth, uid });
  registerSalesAccounts(app, { db, auth, uid });
  registerSalesLeads(app, { db, auth, uid });
  registerSalesDeals(app, { db, auth, uid });

  // For load balancers and uptime checks: confirms the process is up and the database answers.
  app.get("/api/health", async (_req, res) => {
    await db.get("SELECT 1");
    res.json({ ok: true });
  });

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
