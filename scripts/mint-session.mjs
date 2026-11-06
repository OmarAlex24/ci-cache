#!/usr/bin/env node
// Firma un token de sesión con el SESSION_SECRET de .dev.vars (solo para pruebas
// locales contra `wrangler dev`; no es una ruta del Worker).
//
//   node scripts/mint-session.mjs <repoId> <owner/repo> <main|main-ro|rama> <rama> <ci|sandbox>
import { mintSession } from "./e2e/lib.mjs";

const [repoId, repo, tier, branch, kind] = process.argv.slice(2);
if (!repoId || !repo || !tier || !branch || !kind) {
  console.error("uso: node scripts/mint-session.mjs <repoId> <owner/repo> <main|main-ro|rama> <rama> <ci|sandbox>");
  process.exit(2);
}
console.log(await mintSession({ repoId: Number(repoId), repo, tier, branch, kind }));
