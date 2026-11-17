import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import type { Config } from "../config.ts";
import { forbidden, HttpError, unauthorized } from "../errors.ts";
import { resolveTier } from "./policy.ts";
import type { Tier } from "./token.ts";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * GitHub's JWKS, cached at module level (it lives as long as the isolate). jose reuses
 * the keys until `cacheMaxAge` and only fetches them again when an unknown `kid` arrives,
 * at most once every `cooldownDuration`.
 */
export const githubJwks: JWTVerifyGetKey = createRemoteJWKSet(
  new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`),
  { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000, timeoutDuration: 5000 },
);

/** Clock tolerance for `exp`/`nbf`/`iat`, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;

export interface CiIdentity {
  repoId: number;
  repo: string;
  tier: Tier;
  branch: string;
}

function stringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value === "" || value.length > 512) throw unauthorized();
  return value;
}

/**
 * Cheap checks on the unverified JWT (no signature, no JWKS): RS256 with a `kid`, GitHub's
 * issuer, our audience and not expired. Anything that fails here could never pass
 * `jwtVerify`, so it is rejected before the JWKS lookup (the expensive part, and a network
 * fetch when the `kid` is unknown). A well-formed forgery still costs one signature check.
 */
export function precheckOidc(token: string, config: Config, nowSeconds: number): void {
  try {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.iss !== GITHUB_OIDC_ISSUER ||
      !audiences.includes(config.audience) ||
      typeof claims.exp !== "number" ||
      claims.exp < nowSeconds - CLOCK_TOLERANCE_SECONDS
    ) {
      throw unauthorized();
    }
  } catch {
    throw unauthorized();
  }
}

export async function verifyGithubOidc(
  token: string,
  config: Config,
  jwks: JWTVerifyGetKey,
  currentDate?: Date,
): Promise<CiIdentity> {
  precheckOidc(token, config, Math.floor((currentDate ?? new Date()).getTime() / 1000));
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "iat", "nbf"],
      ...(currentDate ? { currentDate } : {}),
    }));
  } catch (error) {
    // Network failures while fetching the JWKS are not the client's fault.
    if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) {
      throw new HttpError(503, "jwks_unavailable", "Could not verify the token, retry");
    }
    throw unauthorized();
  }

  const owner = stringClaim(payload, "repository_owner");
  if (!config.allowedOwners.has(owner.toLowerCase())) throw forbidden("Repository not allowed");

  // GitHub sends repository_id as a string.
  const repoIdText = stringClaim(payload, "repository_id");
  if (!/^[1-9][0-9]{0,15}$/u.test(repoIdText)) throw unauthorized();
  const repoId = Number(repoIdText);
  if (!Number.isSafeInteger(repoId)) throw unauthorized();

  const headRef = payload.head_ref;
  const { tier, branch } = resolveTier(
    {
      event_name: stringClaim(payload, "event_name"),
      ref: stringClaim(payload, "ref"),
      head_ref: typeof headRef === "string" && headRef !== "" ? headRef : undefined,
    },
    config,
  );
  return { repoId, repo: stringClaim(payload, "repository"), tier, branch };
}
