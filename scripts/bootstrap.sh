#!/usr/bin/env bash
# Deploys your own ci-cache instance on your Cloudflare account. Non-interactive and
# idempotent: run it again with the same --name to finish or repair an instance.
#
#   bash scripts/bootstrap.sh --allowed-owners <owner[,owner]> [options]
#
# Options:
#   --allowed-owners <o[,o]>  GitHub users or orgs whose repos may use the cache (required)
#   --name <worker>           Worker name (default ci-cache-<6 random hex>, so the URL is not
#                             guessable). Pass the same name on every rerun.
#   --bucket <name>           R2 bucket (default ci-cache)
#   --location <hint>         R2 location hint for a NEW bucket: weur|eeur|wnam|enam|apac|oc
#                             (default none). Put it near whoever compiles; it can't change later.
#   --rate-limit-namespace <n>  namespace_id of the bad-credential rate limiter (default the
#                             one in wrangler.jsonc); unique in your account
#   --with-stats              also store CF_ACCOUNT_ID and CF_API_TOKEN (read from the
#                             environment) as secrets, for /v1/stats
#   --domain <host>           serve the Worker on this Custom Domain (a hostname in a zone of
#                             the same account) instead of <name>.<subdomain>.workers.dev
#   --dry-run                 only print the commands; runs nothing (wrangler not needed)
#
# Steps: preflight (logged in, R2 enabled, a workers.dev subdomain unless --domain); bucket
# (if missing) and its 2 lifecycle rules (ramas-7d on ramas/, main-30d on main/); deploy
# with a temporary copy of wrangler.jsonc that points at --bucket (outside the repo:
# wrangler.jsonc is never edited); SESSION_SECRET (generated with openssl, only if missing)
# and SANDBOX_KEYS/STATS_KEYS = {} (only if missing), always through stdin. It never prints
# a secret.
#
# Needs: a logged-in wrangler (`pnpm wrangler login` or CLOUDFLARE_API_TOKEN), node, openssl,
# curl. WRANGLER overrides the wrangler command (default: wrangler on PATH, else this repo's).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() {
  echo "bootstrap: $*" >&2
  exit 1
}
usage() {
  sed -n '2,30s/^# \{0,1\}//p' "$0" >&2
  exit 2
}

name="" owners="" bucket=ci-cache location="" namespace="" domain="" with_stats=false dry_run=false
while (($#)); do
  case $1 in
    --name) name=${2:-}; shift 2 ;;
    --allowed-owners) owners=${2:-}; shift 2 ;;
    --bucket) bucket=${2:-}; shift 2 ;;
    --location) location=${2:-}; shift 2 ;;
    --rate-limit-namespace) namespace=${2:-}; shift 2 ;;
    --with-stats) with_stats=true; shift ;;
    --domain) domain=${2:-}; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage ;;
    *) echo "bootstrap: unknown option $1" >&2; usage ;;
  esac
done

[[ -n $owners ]] || fail "--allowed-owners is required (your GitHub user or org, comma-separated)"
[[ $owners =~ ^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$ ]] || fail "--allowed-owners must be GitHub owners separated by commas"
if [[ -z $name ]]; then
  command -v openssl >/dev/null 2>&1 || fail "openssl is required"
  name=ci-cache-$(openssl rand -hex 3)
fi
[[ $name =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "--name must be lowercase letters, digits and dashes"
[[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail "--bucket must be 3-63 lowercase letters, digits and dashes"
case $location in "" | weur | eeur | wnam | enam | apac | oc) ;; *) fail "--location must be weur, eeur, wnam, enam, apac or oc" ;; esac
[[ -z $namespace || $namespace =~ ^[1-9][0-9]{0,9}$ ]] || fail "--rate-limit-namespace must be a positive integer"
[[ -z $domain || $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "--domain must be a lowercase hostname, such as cache.example.com"
if $with_stats; then
  [[ -n ${CF_ACCOUNT_ID:-} && -n ${CF_API_TOKEN:-} ]] || fail "--with-stats reads CF_ACCOUNT_ID and CF_API_TOKEN from the environment: set both"
fi
# wrangler treats CF_API_TOKEN/CF_ACCOUNT_ID as its own (deprecated) login: keep the values
# for the secrets but take them out of wrangler's environment, so it uses your login.
stats_account_id=${CF_ACCOUNT_ID:-} stats_api_token=${CF_API_TOKEN:-}
unset CF_ACCOUNT_ID CF_API_TOKEN
command -v node >/dev/null 2>&1 || fail "node is required"

if [[ -n ${WRANGLER:-} ]]; then
  read -r -a wrangler <<<"$WRANGLER"
elif command -v wrangler >/dev/null 2>&1; then
  wrangler=(wrangler)
elif [[ -x $root/node_modules/.bin/wrangler ]]; then
  wrangler=("$root/node_modules/.bin/wrangler")
elif $dry_run; then
  wrangler=(wrangler) # never run: --dry-run only prints
  echo "bootstrap: wrangler not found (fine for --dry-run; install it before the real run: pnpm install)"
else
  fail "wrangler not found: run pnpm install, or set WRANGLER"
fi
export WRANGLER_SEND_METRICS=false

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
config=$tmp/wrangler.json

# Prints the command (never a secret: those go through stdin) and runs it unless --dry-run.
step() {
  echo "+ wrangler $*"
  $dry_run || "${wrangler[@]}" "$@"
}
# Same, with a secret on stdin. `what` describes the value; the value is never printed.
secret_step() { # <what> <secret name> -- (value on stdin)
  local what=$1 secret=$2
  echo "+ wrangler secret put $secret --name $name   (value: $what, via stdin)"
  if $dry_run; then
    cat >/dev/null
  else
    "${wrangler[@]}" secret put "$secret" --name "$name" >/dev/null
  fi
}

echo "bootstrap: Worker $name, bucket $bucket${location:+ ($location)}, owners $owners"
$dry_run && echo "bootstrap: dry run, nothing runs"

# R2 has to be enabled once per account in the dashboard; until then the API answers
# code 10042 ("Please enable R2 through the Cloudflare Dashboard").
r2_disabled() { grep -qiE '10042|enable R2' <<<"$1"; }
r2_fail() {
  fail "R2 is not enabled on this Cloudflare account. Enable it once in the dashboard
  (Storage & databases > R2 > Overview, then complete the checkout; it needs a payment method on file,
  even within the free tier), then rerun this command. README: \"Before you start: Cloudflare\""
}

# Is there a workers.dev subdomain? A new account may have none, and then `wrangler deploy`
# stops (or, run by an agent, registers one named after the project). Best effort: only a
# definite "none" (API code 10007) fails here; several accounts, an API key login or an
# unreachable API skip the check, and the deploy step still explains a failure.
workers_dev_subdomain() { # prints: ok <subdomain> | missing | unknown
  local account=${CLOUDFLARE_ACCOUNT_ID:-} auth token api
  if [[ -z $account ]]; then
    account=$("${wrangler[@]}" whoami --json 2>/dev/null | node -e '
      let s = require("node:fs").readFileSync(0, "utf8");
      try { const a = JSON.parse(s.slice(s.indexOf("{"))).accounts ?? []; if (a.length === 1) console.log(a[0].id); } catch {}' 2>/dev/null) || true
  fi
  [[ $account =~ ^[0-9a-f]{32}$ ]] || { echo unknown; return 0; }
  # The token stays in this function: from wrangler's stdout to curl's stdin, never argv.
  auth=$("${wrangler[@]}" auth token --json 2>/dev/null) || { echo unknown; return 0; }
  token=$(node -e '
    let s = require("node:fs").readFileSync(0, "utf8");
    try { const a = JSON.parse(s.slice(s.indexOf("{"))); if (a.type !== "api_key" && a.token) console.log(a.token); } catch {}' <<<"$auth" 2>/dev/null) || true
  unset auth
  [[ -n $token ]] || { echo unknown; return 0; }
  api=${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}
  printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --max-time 20 -H @- "$api/accounts/$account/workers/subdomain" 2>/dev/null |
    node -e '
      let s = require("node:fs").readFileSync(0, "utf8");
      try {
        const r = JSON.parse(s);
        if (r.success && r.result?.subdomain) console.log("ok " + r.result.subdomain);
        else if ((r.errors ?? []).some((e) => e.code === 10007)) console.log("missing");
        else console.log("unknown");
      } catch { console.log("unknown"); }' 2>/dev/null || echo unknown
}
subdomain_fail() {
  fail "this account has no workers.dev subdomain yet, so the Worker would have no URL. Register one
  once (Workers & Pages in the dashboard, or https://dash.cloudflare.com/<account id>/workers/onboarding),
  or serve the Worker on your own domain with --domain <host>. Then rerun this command"
}

# 0. Preflight: logged in, R2 enabled, a workers.dev subdomain (unless --domain).
bucket_exists=false
if ! $dry_run; then
  "${wrangler[@]}" whoami >/dev/null 2>&1 || fail "wrangler is not logged in: run pnpm wrangler login"
  if info=$("${wrangler[@]}" r2 bucket info "$bucket" 2>&1); then
    bucket_exists=true
  elif r2_disabled "$info"; then
    r2_fail
  fi
  if [[ -z $domain ]]; then
    read -r found sub <<<"$(workers_dev_subdomain)"
    case $found in
      ok) echo "bootstrap: workers.dev subdomain: $sub" ;;
      missing) subdomain_fail ;;
      *) echo "bootstrap: could not check the account's workers.dev subdomain (skipped)" ;;
    esac
  fi
fi

# 1. Bucket and the 2 lifecycle rules (they cover every repo: the tier is the key's first segment).
if $bucket_exists; then
  echo "bootstrap: bucket $bucket already exists"
  [[ -z $location ]] || echo "bootstrap: (--location only applies to a new bucket)"
elif $dry_run; then
  step r2 bucket create "$bucket" ${location:+--location "$location"}
else
  echo "+ wrangler r2 bucket create $bucket${location:+ --location $location}"
  if ! out=$("${wrangler[@]}" r2 bucket create "$bucket" ${location:+--location "$location"} 2>&1); then
    printf '%s\n' "$out" >&2
    if r2_disabled "$out"; then r2_fail; fi
    fail "could not create the bucket $bucket (wrangler's error above)"
  fi
  printf '%s\n' "$out"
fi
rules=""
$dry_run || rules=$("${wrangler[@]}" r2 bucket lifecycle list "$bucket" 2>/dev/null || true)
for rule in "ramas-7d ramas/ 7" "main-30d main/ 30"; do
  read -r id prefix days <<<"$rule"
  if grep -qw -- "$id" <<<"$rules"; then
    echo "bootstrap: lifecycle rule $id already exists"
  else
    step r2 bucket lifecycle add "$bucket" "$id" "$prefix" --expire-days "$days" --force
  fi
done

# 2. A temporary copy of wrangler.jsonc pointing at --bucket (and --rate-limit-namespace).
#    wrangler.jsonc stays as it is, so `pnpm run deploy` keeps deploying the original setup.
node - "$root/wrangler.jsonc" "$config" "$root/src/index.ts" "$bucket" "$namespace" "$domain" <<'EOF'
const fs = require("node:fs");
const [source, target, main, bucket, namespace, domain] = process.argv.slice(2);
// JSONC → JSON: drop // and /* */ comments outside strings.
const text = fs.readFileSync(source, "utf8");
let out = "";
for (let i = 0, inString = false; i < text.length; i++) {
  const ch = text[i];
  if (inString) {
    out += ch;
    if (ch === "\\") out += text[++i];
    else if (ch === '"') inString = false;
  } else if (ch === '"') {
    inString = true;
    out += ch;
  } else if (ch === "/" && text[i + 1] === "/") {
    while (i < text.length && text[i] !== "\n") i++;
    out += "\n";
  } else if (ch === "/" && text[i + 1] === "*") {
    i = text.indexOf("*/", i + 2) + 1;
  } else out += ch;
}
const config = JSON.parse(out);
delete config.$schema;
config.main = main;
const r2 = (config.r2_buckets ?? []).find((b) => b.binding === "CACHE");
if (!r2) throw new Error("wrangler.jsonc has no CACHE bucket");
r2.bucket_name = bucket;
if (namespace) for (const limiter of config.ratelimits ?? []) limiter.namespace_id = namespace;
// --domain: a Custom Domain (Cloudflare creates its DNS record and certificate), and no
// workers.dev route or preview URLs, so the account's subdomain is in none of its URLs.
if (domain) {
  config.routes = [{ pattern: domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
}
fs.writeFileSync(target, JSON.stringify(config, null, 2));
EOF
echo "bootstrap: deploy config: wrangler.jsonc with bucket_name=$bucket${namespace:+, namespace_id=$namespace}${domain:+, custom domain $domain, workers_dev=false, preview_urls=false} (temporary copy)"

# 3. Deploy. The name and ALLOWED_OWNERS go as flags: no file in the repo changes.
if $dry_run; then
  step deploy --config "$config" --name "$name" --var "ALLOWED_OWNERS:$owners"
  deployed="https://$name.<your-subdomain>.workers.dev"
else
  echo "+ wrangler deploy --config <temporary copy> --name $name --var ALLOWED_OWNERS:$owners"
  if ! "${wrangler[@]}" deploy --config "$config" --name "$name" --var "ALLOWED_OWNERS:$owners" 2>&1 | tee "$tmp/deploy.log"; then
    if grep -qi 'workers.dev subdomain' "$tmp/deploy.log"; then subdomain_fail; fi
    if r2_disabled "$(cat "$tmp/deploy.log")"; then r2_fail; fi
    fail "wrangler deploy failed (its output is above)"
  fi
  deployed=$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$tmp/deploy.log" | head -1 || true)
fi
if [[ -n $domain ]]; then deployed="https://$domain"; fi

# 4. Secrets, only the missing ones. `secret list` prints names only. If it fails, stop:
# taking every secret as missing would replace SESSION_SECRET and empty the key maps.
existing=""
if ! $dry_run; then
  existing=$("${wrangler[@]}" secret list --name "$name" --format json 2>/dev/null) && [[ $existing =~ ^[[:space:]]*\[ ]] ||
    fail "could not list the secrets of $name, so none was set (none is overwritten). Check 'wrangler secret list --name $name' and rerun"
fi
has_secret() { grep -qE "\"name\": *\"$1\"" <<<"$existing"; }

if has_secret SESSION_SECRET; then
  echo "bootstrap: SESSION_SECRET already set (kept: a new one would invalidate every session)"
else
  command -v openssl >/dev/null 2>&1 || fail "openssl is required"
  openssl rand -base64 48 | tr -d '\n' | secret_step "48 random bytes from openssl" SESSION_SECRET
fi
for secret in SANDBOX_KEYS STATS_KEYS; do
  if has_secret "$secret"; then
    echo "bootstrap: $secret already set (kept)"
  else
    printf '{}' | secret_step "{}" "$secret"
  fi
done
if $with_stats; then
  printf '%s' "$stats_account_id" | secret_step "CF_ACCOUNT_ID from the environment" CF_ACCOUNT_ID
  printf '%s' "$stats_api_token" | secret_step "CF_API_TOKEN from the environment" CF_API_TOKEN
fi

[[ -n $deployed ]] || deployed="(see wrangler's output above)"
cat <<EOF

bootstrap: done. Worker: $deployed
Rerun with --name $name to repair or update this instance.

Next steps:
  1. Save the URL as a GitHub Actions **secret** (not a variable) named CI_CACHE_URL, in
     each repo or in the org: GitHub masks secrets in logs, so on public repos the URL never
     shows up in run logs.
       gh secret set CI_CACHE_URL --repo <owner/repo>      # paste the URL when asked
  2. Optional: give sandboxes the same URL as CI_CACHE_URL in their environment.
  3. Mint a key per repo (each prints the key once, plus the hash entry to merge):
       node scripts/new-key.mjs sandbox <repoId> <owner/repo> <label> # -> SANDBOX_KEYS
       node scripts/new-key.mjs stats <label> [repoId,...]           # -> STATS_KEYS
     then: pnpm wrangler secret put SANDBOX_KEYS --name $name   (paste the merged JSON)
  4. Add the setup and report steps to each repo's CI (AGENTS.md, "Connect a repo").
EOF
