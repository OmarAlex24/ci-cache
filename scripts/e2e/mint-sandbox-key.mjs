#!/usr/bin/env node
// Tests skill/ci-cache/scripts/mint-sandbox-key.sh in a temporary key directory: one key per
// repo and label, the refusal without --rotate, --rotate dropping the old hash, and that no
// key is ever printed. No network (CI_CACHE_REPO_ID skips `gh api`), no wrangler.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SCRIPT = join(ROOT, "skill", "ci-cache", "scripts", "mint-sandbox-key.sh");
const work = mkdtempSync(join(tmpdir(), "ci-cache-mint-e2e-"));
const REPO = "acme/my-repo";
const REPO_ID = "123456789";
const VAR = "CI_CACHE_SANDBOX_KEY_MY_REPO";
const sha = (text) => createHash("sha256").update(text).digest("hex");

const envFile = join(work, "keys.env");
const mapFile = join(work, "sandbox_keys.json");
const keys = () =>
  Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
const map = () => JSON.parse(readFileSync(mapFile, "utf8"));
const printed = [];

async function mint(...args) {
  const r = await run("bash", [SCRIPT, REPO, ...args], {
    env: { PATH: process.env.PATH, HOME: work, CI_CACHE_KEYS_DIR: work, CI_CACHE_REPO: ROOT, CI_CACHE_REPO_ID: REPO_ID },
  });
  printed.push(r.stdout + r.stderr);
  return { ...r, out: r.stdout + r.stderr };
}

try {
  console.log("1. the default label");
  let r = await mint();
  check(r.code === 0, `exits 0${r.code ? `: ${r.out}` : ""}`);
  const first = keys()[VAR];
  check(first?.startsWith("sk_"), `stored as ${VAR} in keys.env`);
  check(map()[sha(first)]?.label === "sandbox" && map()[sha(first)].repoId === Number(REPO_ID), "its hash is in the map, label 'sandbox'");
  check((statSync(envFile).mode & 0o077) === 0 && (statSync(mapFile).mode & 0o077) === 0, "keys.env and the map are private (0600)");
  check(!r.out.includes("--label"), "the next steps don't add --label for the default label");

  console.log("2. a second key for the same label is refused");
  r = await mint();
  check(r.code === 1 && r.out.includes("pass --rotate"), "exits 1 and suggests --rotate");
  check(keys()[VAR] === first && Object.keys(map()).length === 1, "and changes nothing");

  console.log("3. another label gets its own key and variable");
  r = await mint("e2b");
  check(r.code === 0, `exits 0${r.code ? `: ${r.out}` : ""}`);
  const second = keys()[`${VAR}__E2B`];
  check(second?.startsWith("sk_") && second !== first, `stored as ${VAR}__E2B`);
  check(keys()[VAR] === first && Object.keys(map()).length === 2, "the default label's key is kept");
  check(r.out.includes("2 sandbox key(s): e2b, sandbox"), "says the repo has two keys and their labels");
  check(r.out.includes("connect-sandbox.sh --label e2b"), "the next steps name the label");

  console.log("4. --rotate replaces one label's key only");
  r = await mint("e2b", "--rotate");
  check(r.code === 0 && r.out.includes("the replaced key's entry was removed"), "exits 0 and says the old entry is gone");
  const rotated = keys()[`${VAR}__E2B`];
  check(rotated !== second && !map()[sha(second)] && map()[sha(rotated)]?.label === "e2b", "the old hash is dropped, the new one is in");
  check(keys()[VAR] === first && map()[sha(first)], "the other label is untouched");

  console.log("5. a key minted before labels had their own variable");
  // An older mint stored a 'boat' key under the label-less name: rotating label 'boat' finds
  // it through the map and removes that variable too.
  const legacy = "sk_legacy-key-for-the-e2e-test-only";
  writeFileSync(mapFile, JSON.stringify({ ...map(), [sha(legacy)]: { repoId: Number(REPO_ID), repo: REPO, label: "boat" } }));
  writeFileSync(envFile, `${readFileSync(envFile, "utf8")}CI_CACHE_SANDBOX_KEY_OLD_NAME=${legacy}\n`);
  r = await mint("boat");
  check(r.code === 1, "minting its label without --rotate is refused");
  r = await mint("boat", "--rotate");
  check(r.code === 0 && !map()[sha(legacy)] && !("CI_CACHE_SANDBOX_KEY_OLD_NAME" in keys()), "--rotate drops its hash and the variable that held it");
  check(keys()[`${VAR}__BOAT`]?.startsWith("sk_"), `and stores the new one as ${VAR}__BOAT`);

  console.log("6. bad input");
  r = await mint("no spaces allowed");
  check(r.code === 2 && r.out.includes("label:"), "a label with spaces is refused");

  console.log("6b. --branches binds the key to branch patterns");
  r = await mint("agents", "--branches", "agent/*,fix/**");
  check(r.code === 0 && r.out.includes("bound to the branches agent/*,fix/**"), `exits 0 and says so${r.code ? `: ${r.out}` : ""}`);
  const bound = keys()[`${VAR}__AGENTS`];
  check(JSON.stringify(map()[sha(bound)]?.branches) === JSON.stringify(["agent/*", "fix/**"]), "the map entry has branches: [agent/*, fix/**]");
  r = await mint("agents", "--rotate");
  const reBound = keys()[`${VAR}__AGENTS`];
  check(
    r.code === 0 && reBound !== bound && !map()[sha(bound)] && JSON.stringify(map()[sha(reBound)]?.branches) === JSON.stringify(["agent/*", "fix/**"]),
    "--rotate without --branches keeps the replaced key's patterns",
  );
  check(r.out.includes("kept from the replaced key"), "and says so");
  r = await mint("agents", "--rotate", "--branches", "bot/*");
  const reBound2 = keys()[`${VAR}__AGENTS`];
  check(r.code === 0 && JSON.stringify(map()[sha(reBound2)]?.branches) === JSON.stringify(["bot/*"]), "--rotate --branches replaces them");
  const entries = Object.keys(map()).length;
  r = await mint("pool2", "--branches", "has space");
  check(r.code === 2 && Object.keys(map()).length === entries && !(`${VAR}__POOL2` in keys()), "a bad pattern is refused and changes nothing");

  console.log("7. never prints a key");
  const all = printed.join("\n");
  const stored = [first, second, rotated, legacy, bound, reBound, reBound2, ...Object.values(keys())];
  check(stored.every((key) => !all.includes(key)), "no key appears in any output");
  check(!/sk_[A-Za-z0-9_-]{20,}/.test(all), "nor anything shaped like one");

  console.log("e2e mint-sandbox-key: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
