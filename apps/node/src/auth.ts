import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** Generates a fresh 256-bit bearer token (43-char base64url, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthenticatedPrincipal {
  userId: string;
}

/** Looks up the user for a raw `Authorization` header value, or null if absent/invalid. */
export async function authenticate(
  prisma: PrismaClient,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedPrincipal | null> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return null;
  return authenticateToken(prisma, token);
}

export async function authenticateToken(
  prisma: PrismaClient,
  token: string,
): Promise<AuthenticatedPrincipal | null> {
  const tokenHash = hashToken(token);
  const user = await prisma.user.findUnique({ where: { tokenHash } });
  if (!user) return null;
  // Constant-time compare against the looked-up hash (defense in depth —
  // the lookup itself is already exact-match, but this avoids any timing
  // signal leaking through a future non-indexed comparison path).
  const a = Buffer.from(tokenHash);
  const b = Buffer.from(user.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId: user.id };
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}

/**
 * Brute-force guard on the small static INVITE_CODES list, keyed by
 * source IP — separate from the generic per-IP request rate limiter on
 * /signup. After `maxFailures` wrong-code attempts within the window, an
 * IP is locked out for `lockoutMs` regardless of whether a later attempt
 * supplies the correct code, so an attacker can't "get lucky" faster by
 * retrying past the failure count.
 */
export class InviteCodeLockout {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly lockoutMs = 15 * 60_000,
  ) {}

  isLocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= Date.now()) {
      this.failures.delete(ip);
      return false;
    }
    return entry.lockedUntil !== 0;
  }

  recordFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = Date.now() + this.lockoutMs;
    }
    this.failures.set(ip, entry);
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}
