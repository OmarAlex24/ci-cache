#!/usr/bin/env node
// Generates a key and the entry that goes into the matching secret. The plaintext key
// is only printed here; the Worker only stores its sha256.
//
//   node scripts/new-key.mjs sandbox <repoId> <owner/repo> [label] [--branches 'agent/*,fix/**']
//                                                                       → SANDBOX_KEYS
//   node scripts/new-key.mjs stats <label> [repoId,repoId...]        → STATS_KEYS
//
// --branches binds a sandbox key to branch patterns (comma-separated, 1 to 32): `*` matches
// within one path segment, `**` across `/`. Without it the key opens sessions on any branch.
import { createHash, randomBytes } from "node:crypto";

const [kind, ...rest] = process.argv.slice(2);
const usage = [
  "usage: node scripts/new-key.mjs sandbox <repoId> <owner/repo> [label] [--branches <pattern,...>]",
  "       node scripts/new-key.mjs stats <label> [repoId,repoId...]",
].join("\n");
const isId = (text) => /^[1-9][0-9]*$/.test(text ?? "");
// The Worker's rule (src/session/keys.ts): a branch name that may contain `*`.
// oxlint-disable-next-line no-control-regex -- excluding control characters is exactly the intent
const BRANCH_PATTERN = /^[^\x00-\x20\x7f~^:?[\\]{1,255}$/u;

const args = [];
let branches;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--branches") {
    branches = (rest[++i] ?? "").split(",").map((pattern) => pattern.trim());
  } else {
    args.push(rest[i]);
  }
}

let prefix;
let secret;
let value;
if (kind === "sandbox") {
  const [repoId, repo, label = ""] = args;
  if (!isId(repoId) || !repo?.includes("/")) fail();
  if (branches && (branches.length > 32 || !branches.every((pattern) => BRANCH_PATTERN.test(pattern)))) {
    console.error("--branches: 1 to 32 comma-separated patterns, each a branch name that may contain *");
    process.exit(2);
  }
  prefix = "sk_";
  secret = "SANDBOX_KEYS";
  value = { repoId: Number(repoId), repo, label, ...(branches ? { branches } : {}) };
} else if (kind === "stats" && branches === undefined) {
  const [label, ids] = args;
  if (!label) fail();
  const repoIds = ids ? ids.split(",") : undefined;
  if (repoIds && !repoIds.every(isId)) fail();
  prefix = "rk_";
  secret = "STATS_KEYS";
  value = repoIds ? { label, repoIds: repoIds.map(Number) } : { label };
} else {
  fail();
}

const key = `${prefix}${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
console.log(`key (save it, it won't be shown again): ${key}`);
console.log(`entry for ${secret} (merge it with the existing ones):`);
console.log(JSON.stringify({ [hash]: value }));

function fail() {
  console.error(usage);
  process.exit(2);
}
