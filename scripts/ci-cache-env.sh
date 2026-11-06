#!/usr/bin/env bash
# Prepara la caché de CI en un sandbox de Boat: pide una sesión al Worker con la
# llave del sandbox y la rama de git actual, y escribe los exports en ~/.ci-cache.env.
#
#   CI_CACHE_URL=https://ci-cache.<cuenta>.workers.dev \
#   CI_CACHE_SANDBOX_KEY=sk_... \
#   bash ci-cache-env.sh [directorio del repo]      # por defecto, el actual
#   source ~/.ci-cache.env
#
# Variables opcionales:
#   CI_CACHE_BRANCH    rama a usar (si HEAD está suelto o quieres otra)
#   CI_CACHE_ENV_FILE  dónde escribir los exports (default ~/.ci-cache.env)
#
# Una llave de sandbox siempre da nivel rama: lo que se escriba aquí nunca llega a main/.
# Nunca imprime la llave ni el token.
set -euo pipefail

fail() {
  echo "ci-cache: $*" >&2
  exit 1
}

# Campo de texto de un JSON plano. jq si existe; si no, sed (la respuesta del Worker es
# JSON compacto y sus valores no llevan comillas escapadas).
json_field() {
  local field=$1 file=$2
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' "$file"
  else
    sed -n "s/.*\"$field\":\"\\([^\"]*\\)\".*/\\1/p" "$file"
  fi
}

url=${CI_CACHE_URL:-}
key=${CI_CACHE_SANDBOX_KEY:-}
dir=${1:-.}
env_file=${CI_CACHE_ENV_FILE:-$HOME/.ci-cache.env}

[[ -n $url ]] || fail "falta CI_CACHE_URL"
[[ -n $key ]] || fail "falta CI_CACHE_SANDBOX_KEY"
[[ $key == sk_* ]] || fail "CI_CACHE_SANDBOX_KEY no parece una llave de sandbox (sk_...)"
url=${url%/}

branch=${CI_CACHE_BRANCH:-}
if [[ -z $branch ]]; then
  branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD) ||
    fail "HEAD está suelto en $dir: haz checkout de una rama o define CI_CACHE_BRANCH"
fi
# git no permite \ ni controles en nombres de rama; solo hay que escapar comillas.
body="{\"branch\":\"${branch//\"/\\\"}\"}"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# La llave va por stdin (-H @-) para que no aparezca en la lista de procesos.
status=$(printf 'Authorization: Bearer %s\n' "$key" | curl -sS --retry 3 -X POST \
  -H @- -H 'content-type: application/json' --data "$body" \
  -o "$tmp" -w '%{http_code}' "$url/v1/session") || fail "no se pudo contactar a $url"
if [[ $status != 200 ]]; then
  fail "POST /v1/session respondió $status: $(json_field message "$tmp")"
fi

token=$(json_field token "$tmp")
tier=$(json_field tier "$tmp")
repo=$(json_field repo "$tmp")
expires=$(json_field expiresAt "$tmp")
[[ -n $token && -n $repo ]] || fail "respuesta de sesión inesperada"

umask 077
{
  echo "# Generado por ci-cache-env.sh: sesión $tier de la rama $branch hasta $expires"
  echo "export TURBO_API='$url'"
  echo "export TURBO_TOKEN='$token'"
  echo "export TURBO_TEAM='${repo#*/}'"
  echo "export SCCACHE_WEBDAV_ENDPOINT='$url/dav'"
  echo "export SCCACHE_WEBDAV_TOKEN='$token'"
  echo "export CARGO_INCREMENTAL=0"
  if command -v sccache >/dev/null 2>&1; then echo "export RUSTC_WRAPPER=sccache"; fi
} >"$env_file"
chmod 600 "$env_file"

# El servidor de sccache se queda con el entorno con que arrancó: reiniciarlo para que
# tome el token nuevo en la próxima compilación.
if command -v sccache >/dev/null 2>&1; then sccache --stop-server >/dev/null 2>&1 || true; fi

echo "ci-cache: sesión $tier de la rama '$branch' ($repo) hasta $expires"
echo "ci-cache: exports en $env_file — cárgalos con: source $env_file"
