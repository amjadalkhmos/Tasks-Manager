import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export const COOKIE = "tm_session";

export interface AuthedRequest extends Request {
  userId: number;
}

export function signToken(userId: number, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: "7d" });
}

export function requireAuth(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = jwt.verify(req.cookies?.[COOKIE] ?? "", secret) as jwt.JwtPayload;
      (req as AuthedRequest).userId = Number(payload.sub);
      next();
    } catch {
      res.status(401).json({ error: "Not authenticated" });
    }
  };
}
