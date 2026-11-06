// Token de sesión propio: `base64url(JSON de claims) "." base64url(HMAC-SHA256)`.
// Se emite en POST /v1/session y cada petición de caché solo verifica la firma.
// Este módulo también lo importan los scripts de Node (scripts/mint-session.mjs),
// así que solo usa Web Crypto estándar.
import { base64UrlDecode, base64UrlEncode, utf8 } from "../crypto.ts";

export const TIERS = ["main", "main-ro", "rama"] as const;
export type Tier = (typeof TIERS)[number];
export const SESSION_KINDS = ["ci", "sandbox"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export interface SessionClaims {
  v: 1;
  /** Id numérico del repo de GitHub. */
  repoId: number;
  /** `owner/name`, informativo. */
  repo: string;
  tier: Tier;
  /** Rama de la sesión (en `main`/`main-ro`, la rama de main). */
  branch: string;
  kind: SessionKind;
  /** Expiración, segundos Unix. */
  exp: number;
}

const MAX_TOKEN_LENGTH = 4096;
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verifica firma (tiempo constante vía `crypto.subtle.verify`), forma y expiración. */
export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number,
): Promise<SessionClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signaturePart] = parts as [string, string];
  const signature = base64UrlDecode(signaturePart);
  const payloadBytes = base64UrlDecode(payload);
  if (!signature || !payloadBytes || signature.byteLength !== 32) return null;

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(payload));
  if (!valid) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isSessionClaims(claims) || claims.exp <= nowSeconds) return null;
  return claims;
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.repoId === "number" &&
    Number.isSafeInteger(c.repoId) &&
    c.repoId > 0 &&
    typeof c.repo === "string" &&
    typeof c.branch === "string" &&
    c.branch !== "" &&
    typeof c.exp === "number" &&
    TIERS.includes(c.tier as Tier) &&
    SESSION_KINDS.includes(c.kind as SessionKind)
  );
}
