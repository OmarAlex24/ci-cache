#!/usr/bin/env node
// Generates a key and the entry that goes into the matching secret. The plaintext key
// is only printed here; the Worker only stores its sha256.
//
//   node scripts/new-key.mjs sandbox <repoId> <owner/repo> [label]   → SANDBOX_KEYS
//   node scripts/new-key.mjs stats <label> [repoId,repoId...]        → STATS_KEYS
import { createHash, randomBytes } from "node:crypto";

const [kind, ...args] = process.argv.slice(2);
const usage = [
  "usage: node scripts/new-key.mjs sandbox <repoId> <owner/repo> [label]",
  "       node scripts/new-key.mjs stats <label> [repoId,repoId...]",
].join("\n");
const isId = (text) => /^[1-9][0-9]*$/.test(text ?? "");

let prefix;
let secret;
let value;
if (kind === "sandbox") {
  const [repoId, repo, label = ""] = args;
  if (!isId(repoId) || !repo?.includes("/")) fail();
  prefix = "sk_";
  secret = "SANDBOX_KEYS";
  value = { repoId: Number(repoId), repo, label };
} else if (kind === "stats") {
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
