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
#   --dry-run                 only print the commands; runs nothing
#
# Steps: bucket (if missing) and its 2 lifecycle rules (ramas-7d on ramas/, main-30d on
# main/); deploy with a temporary copy of wrangler.jsonc that points at --bucket (outside the
# repo: wrangler.jsonc is never edited); SESSION_SECRET (generated with openssl, only if
# missing) and SANDBOX_KEYS/STATS_KEYS = {} (only if missing), always through stdin. It
# never prints a secret.
#
# Needs: a logged-in wrangler (`pnpm wrangler login` or CLOUDFLARE_API_TOKEN), node, openssl.
# WRANGLER overrides the wrangler command (default: wrangler on PATH, else this repo's).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() {
  echo "bootstrap: $*" >&2
  exit 1
}
usage() {
  sed -n '2,26s/^# \{0,1\}//p' "$0" >&2
  exit 2
}

name="" owners="" bucket=ci-cache location="" namespace="" with_stats=false dry_run=false
while (($#)); do
  case $1 in
    --name) name=${2:-}; shift 2 ;;
    --allowed-owners) owners=${2:-}; shift 2 ;;
    --bucket) bucket=${2:-}; shift 2 ;;
    --location) location=${2:-}; shift 2 ;;
    --rate-limit-namespace) namespace=${2:-}; shift 2 ;;
    --with-stats) with_stats=true; shift ;;
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

# 0. Logged in?
if ! $dry_run; then "${wrangler[@]}" whoami >/dev/null 2>&1 || fail "wrangler is not logged in: run pnpm wrangler login"; fi

# 1. Bucket and the 2 lifecycle rules (they cover every repo: the tier is the key's first segment).
if ! $dry_run && "${wrangler[@]}" r2 bucket info "$bucket" >/dev/null 2>&1; then
  echo "bootstrap: bucket $bucket already exists"
  [[ -z $location ]] || echo "bootstrap: (--location only applies to a new bucket)"
else
  step r2 bucket create "$bucket" ${location:+--location "$location"}
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
node - "$root/wrangler.jsonc" "$config" "$root/src/index.ts" "$bucket" "$namespace" <<'EOF'
const fs = require("node:fs");
const [source, target, main, bucket, namespace] = process.argv.slice(2);
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
fs.writeFileSync(target, JSON.stringify(config, null, 2));
EOF
echo "bootstrap: deploy config: wrangler.jsonc with bucket_name=$bucket${namespace:+, namespace_id=$namespace} (temporary copy)"

# 3. Deploy. The name and ALLOWED_OWNERS go as flags: no file in the repo changes.
if $dry_run; then
  step deploy --config "$config" --name "$name" --var "ALLOWED_OWNERS:$owners"
  deployed="https://$name.<your-subdomain>.workers.dev"
else
  echo "+ wrangler deploy --config <temporary copy> --name $name --var ALLOWED_OWNERS:$owners"
  "${wrangler[@]}" deploy --config "$config" --name "$name" --var "ALLOWED_OWNERS:$owners" | tee "$tmp/deploy.log"
  deployed=$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$tmp/deploy.log" | head -1 || true)
fi

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
  2. Give Boat sandboxes the same URL as CI_CACHE_URL in their environment.
  3. Mint a key per repo (each prints the key once, plus the hash entry to merge):
       node scripts/new-key.mjs sandbox <repoId> <owner/repo> boat   # -> SANDBOX_KEYS
       node scripts/new-key.mjs stats <label> [repoId,...]           # -> STATS_KEYS
     then: pnpm wrangler secret put SANDBOX_KEYS --name $name   (paste the merged JSON)
  4. Add the setup and report steps to each repo's CI (AGENTS.md, "Connect a repo").
EOF
