#!/usr/bin/env node
// Signs a session token with the SESSION_SECRET from .dev.vars (only for local tests
// against `wrangler dev`; it is not a Worker route).
//
//   node scripts/mint-session.mjs <repoId> <owner/repo> <main|main-ro|rama> <branch> <ci|sandbox>
import { mintSession } from "./e2e/lib.mjs";

const [repoId, repo, tier, branch, kind] = process.argv.slice(2);
if (!repoId || !repo || !tier || !branch || !kind) {
  console.error("usage: node scripts/mint-session.mjs <repoId> <owner/repo> <main|main-ro|rama> <branch> <ci|sandbox>");
  process.exit(2);
}
console.log(await mintSession({ repoId: Number(repoId), repo, tier, branch, kind }));
