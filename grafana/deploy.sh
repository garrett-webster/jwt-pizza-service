#!/usr/bin/env bash
# Syncs grafana/dashboards/** to Grafana.
#   - Directory structure = folder structure (created if missing, nesting supported)
#   - Each *.json file is a v2 dashboard resource; its title comes from spec.title
#   - metadata.name is kept if present in the file, otherwise derived from the path
set -euo pipefail

: "${GRAFANA_URL:?}" "${GRAFANA_TOKEN:?}" "${GRAFANA_NAMESPACE:?}"
root=${DASHBOARD_ROOT:-grafana/dashboards}
auth="Authorization: Bearer $GRAFANA_TOKEN"

# Fails (printing the status and a snippet of the body) on anything but a 2xx with a body.
# Plain `curl -f` lets redirects and empty 200s through, which hid a bad GRAFANA_URL.
api() {
  local out code
  out=$(curl -sS -w '\n%{http_code}' -H "$auth" -H "Content-Type: application/json" "$@") || return 1
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ $code != 2* || -z $out ]]; then
    echo "Grafana request failed (HTTP $code): $*" >&2
    echo "${out:0:300}" >&2
    return 1
  fi
  printf '%s' "$out"
}

declare -A folder_cache
FOLDER_UID=""

# Resolves (creating as needed) the folder for a slash-separated path. Sets FOLDER_UID.
ensure_folder() {
  local path=$1 parent="" acc="" title url uid
  FOLDER_UID=""
  [ -z "$path" ] && return
  local IFS='/'
  local parts
  read -ra parts <<< "$path"
  IFS=$' \t\n'
  for title in "${parts[@]}"; do
    acc="$acc/$title"
    if [ -n "${folder_cache[$acc]:-}" ]; then
      parent=${folder_cache[$acc]}
      continue
    fi
    url="$GRAFANA_URL/api/folders"
    [ -n "$parent" ] && url+="?parentUid=$parent"
    listing=$(api "$url")
    echo "Folders at '$acc' parent: $(echo "$listing" | jq -c '[.[]? | {title, uid}]' 2>/dev/null || echo "$listing" | head -c 300)"
    uid=$(echo "$listing" | jq -r --arg t "$title" '[.[] | select(.title == $t)][0].uid // empty')
    if [ -z "$uid" ]; then
      echo "Creating folder: $acc"
      uid=$(api -X POST "$GRAFANA_URL/api/folders" \
        -d "$(jq -n --arg t "$title" --arg p "$parent" '{title: $t} + (if $p == "" then {} else {parentUid: $p} end)')" |
        jq -r '.uid')
    fi
    folder_cache[$acc]=$uid
    parent=$uid
  done
  FOLDER_UID=$parent
}

while IFS= read -r -d '' file; do
  rel=${file#"$root"/}
  dir=$(dirname "$rel")
  [ "$dir" = "." ] && dir=""
  ensure_folder "$dir"

  name=$(jq -r '.metadata.name // empty' "$file")
  if [ -z "$name" ]; then
    name=$(echo "${rel%.json}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//' | cut -c1-40)
  fi
  version=$(jq -r '.apiVersion | split("/")[1]' "$file")
  base="$GRAFANA_URL/apis/dashboard.grafana.app/$version/namespaces/$GRAFANA_NAMESPACE/dashboards"

  body=$(jq --arg ns "$GRAFANA_NAMESPACE" --arg name "$name" --arg folder "$FOLDER_UID" '
    .metadata.name = $name
    | .metadata.namespace = $ns
    | if $folder != "" then .metadata.annotations["grafana.app/folder"] = $folder else . end' "$file")

  # Update if it exists (needs its resourceVersion), otherwise create
  existing=$(mktemp)
  code=$(curl -sS -o "$existing" -w '%{http_code}' -H "$auth" "$base/$name")
  if [ "$code" = 200 ]; then
    rv=$(jq -r '.metadata.resourceVersion' "$existing")
    echo "Updating $rel ($name)"
    echo "$body" | jq --arg rv "$rv" '.metadata.resourceVersion = $rv' | api -X PUT "$base/$name" -d @- > /dev/null
    api "$base/$name" | jq -c '{name: .metadata.name, generation: .metadata.generation, folder: .metadata.annotations["grafana.app/folder"], panels: (.spec.elements | keys)}'
  elif [ "$code" = 404 ]; then
    echo "Creating $rel ($name)"
    echo "$body" | api -X POST "$base" -d @- > /dev/null
  else
    echo "Unexpected HTTP $code looking up $name: $(head -c 300 "$existing")" >&2
    exit 1
  fi
  rm -f "$existing"
done < <(find "$root" -name '*.json' -print0 | sort -z)
