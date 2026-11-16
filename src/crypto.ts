const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(text)));
}

/** First 16 hex chars of sha256(branch name): the branch segment in R2 keys. */
export async function branchKey(branch: string): Promise<string> {
  return (await sha256Hex(branch)).slice(0, 16);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/u;

/** Decodes base64url; returns null if the input is not valid base64url. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time comparison (Workers). Different lengths → false without comparing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}
