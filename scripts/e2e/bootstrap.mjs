#!/usr/bin/env node
// Tests scripts/bootstrap.sh without touching any Cloudflare account: a fake `wrangler`
// records every call (argv, and stdin for `secret put`) and keeps the state of a fake
// account in a temporary directory. PATH holds only the fake wrangler and the tools the
// script needs, HOME is temporary and CLOUDFLARE_API_BASE_URL points at a local fake of the
// one Cloudflare API call the script makes itself (the workers.dev subdomain). Finally the
// real wrangler builds the generated config with `deploy --dry-run` (no network, no login).
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SCRIPT = join(ROOT, "scripts", "bootstrap.sh");
const work = mkdtempSync(join(tmpdir(), "ci-cache-bootstrap-e2e-"));
const bin = join(work, "bin");
mkdirSync(bin);

// The fake account's id and OAuth token. The subdomain API answers per account id below.
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const NO_SUBDOMAIN_ID = "fedcba9876543210fedcba9876543210";
const OAUTH_TOKEN = "fake-oauth-token-0123456789abcdef";
const apiCalls = [];
const api = createServer((req, res) => {
  apiCalls.push({ url: req.url, auth: req.headers.authorization });
  res.writeHead(200, { "content-type": "application/json" });
  if (req.headers.authorization !== `Bearer ${OAUTH_TOKEN}`) return res.end(JSON.stringify({ success: false, errors: [{ code: 10000 }] }));
  if (req.url === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`) return res.end(JSON.stringify({ success: true, errors: [], result: { subdomain: "example-account" } }));
  if (req.url === `/client/v4/accounts/${NO_SUBDOMAIN_ID}/workers/subdomain`) return res.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This account doesn't have a workers.dev subdomain" }], result: null }));
  res.end(JSON.stringify({ success: false, errors: [{ code: 7003 }] }));
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const API_BASE = `http://127.0.0.1:${api.address().port}/client/v4`;

const FAKE = `#!/usr/bin/env bash
# Fake wrangler: logs argv, emulates a Cloudflare account under $FAKE_STATE.
#   FAKE_R2_DISABLED   R2 not enabled on the account (code 10042)
#   FAKE_ACCOUNT       the account id whoami --json reports (default ${ACCOUNT_ID})
#   FAKE_DEPLOY_NO_SUBDOMAIN  deploy fails as wrangler does without a workers.dev subdomain
set -u
s=$FAKE_STATE
mkdir -p "$s/secrets"
printf '%s\\n' "$*" >>"$FAKE_LOG"
r2_off() { echo "✘ [ERROR] A request to the Cloudflare API (/accounts/x/r2/buckets) failed." >&2; echo "  Please enable R2 through the Cloudflare Dashboard. [code: 10042]" >&2; exit 1; }
case "$1 \${2:-} \${3:-}" in
  "whoami --json ") printf '{"loggedIn":true,"authType":"OAuth Token","accounts":[{"id":"%s","name":"Acme"}]}\\n' "\${FAKE_ACCOUNT:-${ACCOUNT_ID}}" ;;
  "whoami "*) echo "logged in" ;;
  "auth token --json") printf '{"type":"oauth","token":"${OAUTH_TOKEN}"}\\n' ;;
  "r2 bucket info") [ -z "\${FAKE_R2_DISABLED:-}" ] || r2_off; [ -f "$s/bucket-$4" ] || { echo "The specified bucket does not exist. [code: 10006]" >&2; exit 1; } ;;
  "r2 bucket create") [ -z "\${FAKE_R2_DISABLED:-}" ] || r2_off; touch "$s/bucket-$4" ;;
  "r2 bucket lifecycle")
    if [ "$4" = list ]; then cat "$s/rules-$5" 2>/dev/null; else echo "$6" >>"$s/rules-$5"; fi ;;
  "deploy "*)
    if [ -n "\${FAKE_DEPLOY_NO_SUBDOMAIN:-}" ]; then
      echo "▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev" >&2
      echo "✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.json file, or register a workers.dev subdomain here:" >&2
      echo "  https://dash.cloudflare.com/x/workers/onboarding" >&2; exit 1
    fi
    shift; while [ $# -gt 0 ]; do case $1 in --config) cp "$2" "$s/deployed.json"; shift 2 ;; --name) n=$2; shift 2 ;; *) shift ;; esac; done
    echo "Uploaded $n"; echo "Deployed $n triggers"; echo "  https://$n.example-account.workers.dev" ;;
  "secret list "*)
    [ -z "\${FAKE_SECRET_LIST_FAIL:-}" ] || { echo "fake wrangler: API error" >&2; exit 1; }
    printf '['; sep=""; for f in "$s"/secrets/*; do [ -e "$f" ] || continue; printf '%s{"name": "%s", "type": "secret_text"}' "$sep" "$(basename "$f")"; sep=","; done; echo ']' ;;
  "secret put "*) cat >"$s/secrets/$3"; echo "Success! Uploaded secret $3" ;;
  *) echo "fake wrangler: unexpected call: $*" >&2; exit 9 ;;
esac
`;
writeFileSync(join(bin, "wrangler"), FAKE);
chmodSync(join(bin, "wrangler"), 0o755);
const TOOLS = ["node", "openssl", "bash", "sed", "grep", "tr", "cat", "mktemp", "rm", "tee", "head", "dirname", "env", "touch", "cp", "mkdir", "basename", "curl"];
for (const tool of TOOLS) {
  const found = (await run("bash", ["-c", `command -v ${tool}`])).stdout.trim();
  if (found) symlinkSync(found, join(bin, tool));
}

let n = 0;
/** One fake account per `account` name; returns the calls and the script's output. */
async function bootstrap(args, { account = `acct${++n}`, env = {} } = {}) {
  const state = join(work, account);
  mkdirSync(state, { recursive: true });
  const log = join(state, "calls.log");
  writeFileSync(log, "", { flag: "a" });
  const before = readFileSync(log, "utf8");
  const home = join(work, `home-${account}`);
  mkdirSync(home, { recursive: true });
  const r = await run("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    env: { PATH: bin, HOME: home, FAKE_STATE: state, FAKE_LOG: log, WRANGLER: join(bin, "wrangler"), CLOUDFLARE_API_BASE_URL: API_BASE, ...env },
  });
  const calls = readFileSync(log, "utf8").slice(before.length).split("\n").filter(Boolean);
  const secret = (name) => {
    try {
      return readFileSync(join(state, "secrets", name), "utf8");
    } catch {
      return undefined;
    }
  };
  return { ...r, out: r.stdout + r.stderr, calls, state, secret };
}

try {
  const wranglerBefore = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");

  console.log("1. --dry-run");
  let r = await bootstrap(["--allowed-owners", "acme,other-org", "--dry-run"]);
  check(r.code === 0, "exits 0");
  check(r.calls.length === 0, "runs no wrangler command at all");
  const name = /Worker (ci-cache-[0-9a-f]{6}),/.exec(r.out)?.[1];
  check(Boolean(name), `default name ci-cache-<6 hex> (${name})`);
  for (const line of [
    "+ wrangler r2 bucket create ci-cache",
    "+ wrangler r2 bucket lifecycle add ci-cache ramas-7d ramas/ --expire-days 7 --force",
    "+ wrangler r2 bucket lifecycle add ci-cache main-30d main/ --expire-days 30 --force",
    `--name ${name} --var ALLOWED_OWNERS:acme,other-org`,
    `+ wrangler secret put SESSION_SECRET --name ${name}   (value: 48 random bytes from openssl, via stdin)`,
    `+ wrangler secret put SANDBOX_KEYS --name ${name}   (value: {}, via stdin)`,
    `+ wrangler secret put STATS_KEYS --name ${name}   (value: {}, via stdin)`,
  ]) {
    check(r.out.includes(line), `prints: ${line.slice(0, 90)}`);
  }
  check(!/[A-Za-z0-9+/]{60,}/.test(r.out), "prints no generated secret");

  console.log("1b. --dry-run without wrangler anywhere (a copy of the repo with no node_modules)");
  const bare = join(work, "bare");
  mkdirSync(join(bare, "root", "scripts"), { recursive: true });
  mkdirSync(join(bare, "bin"));
  copyFileSync(SCRIPT, join(bare, "root", "scripts", "bootstrap.sh"));
  copyFileSync(join(ROOT, "wrangler.jsonc"), join(bare, "root", "wrangler.jsonc"));
  for (const tool of TOOLS) symlinkSync(join(bin, tool), join(bare, "bin", tool));
  r = await run("bash", [join(bare, "root", "scripts", "bootstrap.sh"), "--allowed-owners", "acme", "--dry-run"], { env: { PATH: join(bare, "bin"), HOME: bare } });
  const bareOut = r.stdout + r.stderr;
  check(r.code === 0 && bareOut.includes("wrangler not found (fine for --dry-run") && bareOut.includes("+ wrangler deploy --config"), `exits 0 and prints the plan${r.code ? `: ${bareOut}` : ""}`);
  r = await run("bash", [join(bare, "root", "scripts", "bootstrap.sh"), "--allowed-owners", "acme"], { env: { PATH: join(bare, "bin"), HOME: bare } });
  check(r.code !== 0 && (r.stdout + r.stderr).includes("wrangler not found: run pnpm install"), "the real run still needs wrangler");

  console.log("2. a real run against the fake account");
  const args = ["--name", "ci-cache-test01", "--allowed-owners", "acme", "--bucket", "my-cache", "--location", "weur", "--rate-limit-namespace", "9001"];
  r = await bootstrap(args, { account: "main" });
  check(r.code === 0, `exits 0${r.code ? `: ${r.out}` : ""}`);
  const verbs = r.calls.map((c) => c.split(" ").slice(0, 3).join(" "));
  check(
    JSON.stringify(verbs) ===
      JSON.stringify([
        "whoami",
        "r2 bucket info",
        "whoami --json",
        "auth token --json",
        "r2 bucket create",
        "r2 bucket lifecycle",
        "r2 bucket lifecycle",
        "r2 bucket lifecycle",
        "deploy --config " + r.calls.find((c) => c.startsWith("deploy")).split(" ")[2],
        "secret list --name",
        "secret put SESSION_SECRET",
        "secret put SANDBOX_KEYS",
        "secret put STATS_KEYS",
      ]),
    "calls: whoami, bucket info, the subdomain preflight, bucket, 2 lifecycle rules, deploy, then the missing secrets",
  );
  check(r.out.includes("workers.dev subdomain: example-account"), "the preflight finds the account's workers.dev subdomain");
  check(apiCalls.at(-1)?.auth === `Bearer ${OAUTH_TOKEN}` && !r.calls.join("\n").includes(OAUTH_TOKEN) && !r.out.includes(OAUTH_TOKEN), "the OAuth token goes to the API in a header, never in argv or the output");
  check(r.calls.includes("r2 bucket create my-cache --location weur"), "creates the bucket with the location hint");
  check(r.calls.includes("r2 bucket lifecycle add my-cache ramas-7d ramas/ --expire-days 7 --force"), "rule ramas-7d on ramas/");
  check(r.calls.includes("r2 bucket lifecycle add my-cache main-30d main/ --expire-days 30 --force"), "rule main-30d on main/");
  const deploy = r.calls.find((c) => c.startsWith("deploy"));
  check(deploy.endsWith("--name ci-cache-test01 --var ALLOWED_OWNERS:acme"), "deploys with --name and --var ALLOWED_OWNERS");
  check(!deploy.includes(ROOT), "the deploy config is a temporary copy outside the repo");
  const deployed = JSON.parse(readFileSync(join(r.state, "deployed.json"), "utf8"));
  check(deployed.r2_buckets[0].bucket_name === "my-cache" && deployed.main === join(ROOT, "src", "index.ts"), "the copy points at --bucket and at src/index.ts");
  check(deployed.ratelimits[0].namespace_id === "9001" && deployed.vars.CACHE_AUDIENCE === "ci-cache", "keeps the rest of wrangler.jsonc, with --rate-limit-namespace");
  check(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8") === wranglerBefore, "wrangler.jsonc is untouched");
  const sessionSecret = r.secret("SESSION_SECRET");
  check(sessionSecret?.length === 64 && /^[A-Za-z0-9+/=]+$/.test(sessionSecret), "SESSION_SECRET: 48 random bytes, base64, through stdin");
  check(r.secret("SANDBOX_KEYS") === "{}" && r.secret("STATS_KEYS") === "{}", "SANDBOX_KEYS and STATS_KEYS = {}");
  check(!r.calls.join("\n").includes(sessionSecret) && !r.out.includes(sessionSecret), "the secret is in no argv and in no output");
  check(r.out.includes("Worker: https://ci-cache-test01.example-account.workers.dev"), "prints the Worker URL at the end");
  check(r.out.includes("GitHub Actions **secret** (not a variable) named CI_CACHE_URL") && r.out.includes("new-key.mjs sandbox"), "prints the next steps (secret CI_CACHE_URL, new-key.mjs)");

  console.log("3. idempotent: the same command again");
  r = await bootstrap(args, { account: "main" });
  check(r.code === 0, "exits 0");
  check(!r.calls.some((c) => c.startsWith("r2 bucket create") || c.startsWith("r2 bucket lifecycle add")), "doesn't create the bucket or the rules again");
  check(!r.calls.some((c) => c.startsWith("secret put")), "puts no secret again");
  check(r.secret("SESSION_SECRET") === sessionSecret && r.out.includes("SESSION_SECRET already set"), "keeps SESSION_SECRET");
  check(r.calls.some((c) => c.startsWith("deploy")), "deploys again (picks up code changes)");

  console.log("3b. a failed secret list stops before any secret is set");
  const keysBefore = ["SESSION_SECRET", "SANDBOX_KEYS", "STATS_KEYS"].map((k) => r.secret(k));
  r = await bootstrap(args, { account: "main", env: { FAKE_SECRET_LIST_FAIL: "1" } });
  check(r.code !== 0 && r.out.includes("could not list the secrets of ci-cache-test01"), `exits non-zero and says why (code ${r.code})`);
  check(!r.calls.some((c) => c.startsWith("secret put")), "puts no secret");
  check(
    ["SESSION_SECRET", "SANDBOX_KEYS", "STATS_KEYS"].every((k, i) => r.secret(k) === keysBefore[i] && keysBefore[i] !== undefined),
    "SESSION_SECRET, SANDBOX_KEYS and STATS_KEYS are unchanged",
  );

  console.log("4. --with-stats");
  const account = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
  const token = "cf-test-token-value-0123456789";
  r = await bootstrap(["--name", "ci-cache-stats1", "--allowed-owners", "acme", "--with-stats"], { env: { CF_ACCOUNT_ID: account, CF_API_TOKEN: token } });
  check(r.code === 0 && r.secret("CF_ACCOUNT_ID") === account && r.secret("CF_API_TOKEN") === token, "stores CF_ACCOUNT_ID and CF_API_TOKEN from the environment");
  check(!r.calls.join("\n").includes(token) && !r.out.includes(token) && !r.out.includes(account), "neither value is in argv or in the output");
  r = await bootstrap(["--allowed-owners", "acme", "--with-stats"]);
  check(r.code !== 0 && r.out.includes("CF_ACCOUNT_ID and CF_API_TOKEN"), "without them it fails before doing anything");
  check(r.calls.length === 0, "and calls nothing");

  console.log("4b. preflight: R2 not enabled");
  r = await bootstrap(["--name", "ci-cache-nor2", "--allowed-owners", "acme"], { env: { FAKE_R2_DISABLED: "1" } });
  check(r.code !== 0 && r.out.includes("R2 is not enabled on this Cloudflare account") && r.out.includes("R2 > Overview"), `fails with how to enable R2 (code ${r.code})`);
  check(!r.calls.some((c) => c.startsWith("r2 bucket create") || c.startsWith("deploy") || c.startsWith("secret")), "creates nothing, deploys nothing, sets no secret");

  console.log("4c. preflight: no workers.dev subdomain");
  r = await bootstrap(["--name", "ci-cache-nosub", "--allowed-owners", "acme"], { env: { FAKE_ACCOUNT: NO_SUBDOMAIN_ID } });
  check(r.code !== 0 && r.out.includes("no workers.dev subdomain yet") && r.out.includes("--domain"), `fails with how to register one, or --domain (code ${r.code})`);
  check(!r.calls.some((c) => c.startsWith("r2 bucket create") || c.startsWith("deploy") || c.startsWith("secret")), "creates nothing, deploys nothing, sets no secret");
  r = await bootstrap(["--name", "ci-cache-nosub2", "--allowed-owners", "acme"], { env: { FAKE_DEPLOY_NO_SUBDOMAIN: "1", CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:9/unreachable" } });
  check(r.out.includes("could not check the account's workers.dev subdomain (skipped)"), "an unreachable API skips the check");
  check(r.code !== 0 && r.out.includes("no workers.dev subdomain yet") && !r.calls.some((c) => c.startsWith("secret put")), "and wrangler's own refusal at deploy gets the same message, before any secret");

  console.log("4d. --domain: a Custom Domain instead of workers.dev");
  r = await bootstrap(["--name", "ci-cache-dom", "--allowed-owners", "acme", "--domain", "cache.example.com"], { env: { FAKE_ACCOUNT: NO_SUBDOMAIN_ID } });
  check(r.code === 0, `exits 0 even without a workers.dev subdomain${r.code ? `: ${r.out}` : ""}`);
  const domainConfig = JSON.parse(readFileSync(join(r.state, "deployed.json"), "utf8"));
  check(
    JSON.stringify(domainConfig.routes) === JSON.stringify([{ pattern: "cache.example.com", custom_domain: true }]) && domainConfig.workers_dev === false && domainConfig.preview_urls === false,
    "the deploy config has the custom domain route, workers_dev: false and preview_urls: false",
  );
  check(!r.calls.some((c) => c.startsWith("auth token")) && r.out.includes("Worker: https://cache.example.com"), "skips the subdomain check and prints https://<domain>");

  console.log("5. validation");
  for (const [bad, message] of [
    [[], "--allowed-owners is required"],
    [["--allowed-owners", "acme;rm"], "--allowed-owners must be"],
    [["--allowed-owners", "acme", "--name", "Bad_Name"], "--name must be"],
    [["--allowed-owners", "acme", "--location", "mars"], "--location must be"],
    [["--allowed-owners", "acme", "--bucket", "x"], "--bucket must be"],
    [["--allowed-owners", "acme", "--domain", "https://x.example.com"], "--domain must be"],
  ]) {
    r = await bootstrap(bad);
    check(r.code !== 0 && r.out.includes(message) && r.calls.length === 0, `rejects ${JSON.stringify(bad)}`);
  }

  console.log("6. the generated config builds with the real wrangler (deploy --dry-run, offline)");
  const configDir = mkdtempSync(join(tmpdir(), "ci-cache-bootstrap-config-"));
  const config = join(configDir, "wrangler.json");
  writeFileSync(config, readFileSync(join(work, "main", "deployed.json")));
  const domainCopy = join(configDir, "wrangler-domain.json");
  writeFileSync(domainCopy, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), routes: domainConfig.routes, workers_dev: false, preview_urls: false }));
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLOUDFLARE_") && !k.startsWith("CF_")));
  const out = execFileSync(
    join(ROOT, "node_modules", ".bin", "wrangler"),
    ["deploy", "--dry-run", "--config", config, "--name", "ci-cache-test01", "--outdir", join(configDir, "dist")],
    { cwd: configDir, env: { ...isolated, HOME: join(work, "home-real"), WRANGLER_SEND_METRICS: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  check(out.includes("my-cache") && out.includes("BAD_CREDENTIAL_LIMITER") && out.includes("--dry-run: exiting now"), "wrangler accepts it: R2 my-cache, the rate limiter, dry run");
  check(readdirSync(join(configDir, "dist")).some((f) => f.endsWith(".js")), "and bundles the Worker");
  const domainOut = execFileSync(
    join(ROOT, "node_modules", ".bin", "wrangler"),
    ["deploy", "--dry-run", "--config", domainCopy, "--name", "ci-cache-dom", "--outdir", join(configDir, "dist2")],
    { cwd: configDir, env: { ...isolated, HOME: join(work, "home-real"), WRANGLER_SEND_METRICS: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  check(domainOut.includes("--dry-run: exiting now"), "and accepts the --domain config (routes with custom_domain)");
  rmSync(configDir, { recursive: true, force: true });

  console.log("e2e bootstrap: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  api.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
