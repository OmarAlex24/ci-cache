import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { Config } from "../config.ts";
import { forbidden, HttpError, unauthorized } from "../errors.ts";
import { resolveTier } from "./policy.ts";
import type { Tier } from "./token.ts";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * JWKS de GitHub, cacheado a nivel de módulo (vive lo que viva el isolate). jose
 * reutiliza las llaves hasta `cacheMaxAge` y solo vuelve a pedirlas si llega un `kid`
 * desconocido, como mucho una vez cada `cooldownDuration`.
 */
export const githubJwks: JWTVerifyGetKey = createRemoteJWKSet(
  new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`),
  { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000, timeoutDuration: 5000 },
);

/** Margen de reloj para `exp`/`nbf`/`iat`, en segundos. */
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

export async function verifyGithubOidc(
  token: string,
  config: Config,
  jwks: JWTVerifyGetKey,
  currentDate?: Date,
): Promise<CiIdentity> {
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
    // Fallos de red al pedir el JWKS no son culpa del cliente.
    if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) {
      throw new HttpError(503, "jwks_unavailable", "No se pudo verificar el token, reintenta");
    }
    throw unauthorized();
  }

  const owner = stringClaim(payload, "repository_owner");
  if (!config.allowedOwners.has(owner.toLowerCase())) throw forbidden("Repositorio no permitido");

  // GitHub manda repository_id como cadena.
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
