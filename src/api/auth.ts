import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { DB } from "../core/db.js";

export type Role = "read" | "write" | "admin";
const ROLE_LEVEL: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthState { role: Role; mode: "token" | "open"; name: string }

/** 认证：Bearer Token（sha256 存库）。未配置任何 token 时为 open 模式（开发/演示），生产必须配置。 */
export function makeAuthHook(db: DB) {
  return async function auth(req: FastifyRequest, reply: FastifyReply) {
    const url = req.url;
    if (url === "/health" || url.startsWith("/public/") || url === "/" || url.startsWith("/console")) {
      (req as any).auth = { role: "read", mode: "open", name: "console" } satisfies AuthState;
      return;
    }
    if (!url.startsWith("/api/")) {
      (req as any).auth = { role: "read", mode: "open", name: "static" } satisfies AuthState;
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const tokens = db.prepare(`SELECT * FROM api_tokens`).all() as any[];
    if (!tokens.length) {
      (req as any).auth = { role: "admin", mode: "open", name: "anonymous" } satisfies AuthState;
      return;
    }
    if (!token) {
      reply.code(401).send({ error: "missing bearer token" });
      return;
    }
    const row = db.prepare(`SELECT * FROM api_tokens WHERE token_hash=?`).get(hashToken(token)) as any;
    if (!row) {
      reply.code(401).send({ error: "invalid token" });
      return;
    }
    (req as any).auth = { role: row.role as Role, mode: "token", name: row.name } satisfies AuthState;
  };
}

export function requireRole(req: FastifyRequest, reply: FastifyReply, min: Role): boolean {
  const auth = (req as any).auth as AuthState | undefined;
  const level = auth ? ROLE_LEVEL[auth.role] ?? 0 : 0;
  if (level < ROLE_LEVEL[min]) {
    reply.code(403).send({ error: `requires ${min} role` });
    return false;
  }
  return true;
}
