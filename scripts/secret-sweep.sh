#!/usr/bin/env bash
# Repo-wide pattern sweep: generic secret shapes, capture-file artifacts
# that should never be committed, and a fragment-built check for three
# forbidden project-name strings. Scans the whole committed-file scope
# (tracked plus untracked-but-not-gitignored files), scripts/ (this
# file's own directory) included, with no exclusion.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failed=0

fail() {
  echo "[secret-sweep] $1" >&2
  failed=1
}

# NUL-delimited: safe for any filename, including one containing a space
# or a newline. Bash 3.2 compatible (`read -d ''` is POSIX-era, not a
# bash-4-only feature like `mapfile`).
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(git ls-files -z --cached --others --exclude-standard)

# Runs one pattern against one file. `grep` exits 0 (match found), 1 (no
# match, the normal/expected outcome for a clean file), or 2+ (a real
# error: unreadable file, bad pattern, etc.). Only 0 is reported as a
# finding; only 1 is treated as "nothing to report"; anything else is
# itself a sweep failure, since a silent grep error would let a real
# secret slip past unnoticed. `--` before the file list stops a
# filename that happens to start with `-` from being parsed as an option.
report_matches() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  local hits status
  set +e
  hits="$(grep -nEHIi -- "$pattern" "$file" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && fail "$label: $line"
    done <<< "$hits"
  elif [ "$status" -ne 1 ]; then
    fail "grep error while scanning $file for $label (exit $status): $hits"
  fi
}

# --- Generic secret-shaped patterns (JWT, AWS, GitHub, Slack, Google, ---
# --- plus this CLI's own Vanta OAuth client id/secret prefixes). ---
secret_patterns=(
  "jwt-looking token|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
  "AWS access key id|AKIA[0-9A-Z]{16}"
  "GitHub personal access token|gh[pousr]_[A-Za-z0-9]{36}"
  "GitHub fine-grained token|github_pat_[A-Za-z0-9_]{22,}"
  "Slack token|xox[baprs]-[A-Za-z0-9-]{10,}"
  "Google API key|AIza[0-9A-Za-z_-]{35}"
  "generic bearer token|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}"
  "Vanta OAuth client id|vci_[A-Za-z0-9._~+/=-]{16,}"
  "Vanta OAuth client secret|vcs_[A-Za-z0-9._~+/=-]{16,}"
)

for entry in "${secret_patterns[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  for file in "${files[@]}"; do
    [ -f "$file" ] || continue
    report_matches "$label" "$pattern" "$file"
  done
done

# --- Capture-file artifacts that should never be committed. ---
for file in "${files[@]}"; do
  base="$(basename "$file")"
  case "$base" in
    *.session.json|cookies.*|storage-state.json)
      fail "capture-file artifact committed: $file"
      ;;
  esac
done

# --- Forbidden project-name strings, built from concatenated fragments ---
# --- at runtime so this file's own source never contains the literal ---
# --- strings it checks for. ---
p1="drop""sheet"
p2="one""leet"
p3="dan""iel""gwilson"
forbidden_pattern="${p1}|${p2}|${p3}"

for file in "${files[@]}"; do
  [ -f "$file" ] || continue
  report_matches "forbidden project-name string" "$forbidden_pattern" "$file"
done

if [ "$failed" -ne 0 ]; then
  echo "[secret-sweep] FAILED" >&2
  exit 1
fi
echo "[secret-sweep] ok"
