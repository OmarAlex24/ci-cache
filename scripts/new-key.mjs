#!/usr/bin/env node
// Genera una llave de sandbox y la entrada que va en el secret SANDBOX_KEYS.
// La llave en claro solo se imprime aquí: guárdala en el gestor de secretos del
// sandbox (CI_CACHE_SANDBOX_KEY). El Worker solo guarda su sha256.
//
//   node scripts/new-key.mjs sandbox <repoId> <owner/repo> [etiqueta]
import { createHash, randomBytes } from "node:crypto";

const [kind, repoIdText, repo, label = ""] = process.argv.slice(2);
const usage = "uso: node scripts/new-key.mjs sandbox <repoId> <owner/repo> [etiqueta]";
if (kind !== "sandbox" || !/^[1-9][0-9]*$/.test(repoIdText ?? "") || !repo?.includes("/")) {
  console.error(usage);
  process.exit(2);
}

const key = `sk_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const entry = { [hash]: { repoId: Number(repoIdText), repo, label } };

console.log(`llave (guárdala, no se vuelve a mostrar): ${key}`);
console.log("entrada para SANDBOX_KEYS (fusiónala con las existentes):");
console.log(JSON.stringify(entry));
