#!/usr/bin/env node
// Genera una llave y la entrada que va en el secret correspondiente. La llave en
// claro solo se imprime aquí; el Worker solo guarda su sha256.
//
//   node scripts/new-key.mjs sandbox <repoId> <owner/repo> [etiqueta]   → SANDBOX_KEYS
//   node scripts/new-key.mjs stats <etiqueta> [repoId,repoId...]        → STATS_KEYS
import { createHash, randomBytes } from "node:crypto";

const [kind, ...args] = process.argv.slice(2);
const usage = [
  "uso: node scripts/new-key.mjs sandbox <repoId> <owner/repo> [etiqueta]",
  "     node scripts/new-key.mjs stats <etiqueta> [repoId,repoId...]",
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
console.log(`llave (guárdala, no se vuelve a mostrar): ${key}`);
console.log(`entrada para ${secret} (fusiónala con las existentes):`);
console.log(JSON.stringify({ [hash]: value }));

function fail() {
  console.error(usage);
  process.exit(2);
}
