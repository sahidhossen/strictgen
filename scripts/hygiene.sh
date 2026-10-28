#!/usr/bin/env bash
# Public hygiene check. Fails if the repo or its commit messages contain
# blocked words, internal files, likely secrets, attribution lines or stray files.
#
# Blocked words come from $HYGIENE_DENYLIST (newline separated) or a local,
# untracked .hygiene-denylist file. Commit messages are checked from
# $HYGIENE_BASE (default origin/main) to HEAD.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
report() {
  echo "hygiene: $1" >&2
  fail=1
}

denylist="$(mktemp)"
trap 'rm -f "$denylist"' EXIT
if [[ -n "${HYGIENE_DENYLIST:-}" ]]; then
  printf '%s\n' "$HYGIENE_DENYLIST" >"$denylist"
elif [[ -f .hygiene-denylist ]]; then
  cp .hygiene-denylist "$denylist"
else
  echo "hygiene: no denylist found, skipping blocked-word checks" >&2
fi
sed -i.bak '/^[[:space:]]*$/d' "$denylist" && rm -f "$denylist.bak"

# Tracked and staged files, excluding deleted ones.
files="$(git ls-files --cached --exclude-standard | while read -r f; do [[ -e "$f" ]] && echo "$f"; done)"

# 1. Internal files that must never be tracked.
internal='^(CLAUDE\.md|CLAUDE\.local\.md|\.claude/|strictgen-spec\.md|\.hygiene-denylist)|\.local\.md$'
if hits="$(grep -E "$internal" <<<"$files")"; then
  report "internal files are tracked:"$'\n'"$hits"
fi

# 2. Stray files.
stray='(^|/)(\.DS_Store|node_modules/|dist/|target/|coverage/)|\.log$|(^|/)\.env'
if hits="$(grep -E "$stray" <<<"$files")"; then
  report "stray files are tracked:"$'\n'"$hits"
fi

if [[ -s "$denylist" && -n "$files" ]]; then
  # 3. Blocked words in file paths and contents.
  if hits="$(grep -iFf "$denylist" <<<"$files")"; then
    report "blocked word in file paths:"$'\n'"$hits"
  fi
  if hits="$(tr '\n' '\0' <<<"$files" | xargs -0 grep -IilFf "$denylist" -- 2>/dev/null)"; then
    report "blocked word in files:"$'\n'"$hits"
  fi
fi

# 4. Likely secrets.
secrets='-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16}'
if [[ -n "$files" ]]; then
  if hits="$(tr '\n' '\0' <<<"$files" | xargs -0 grep -IlE -e "$secrets" -- 2>/dev/null)"; then
    report "possible secret in:"$'\n'"$hits"
  fi
fi

# 5. Commit messages on this branch.
base="${HYGIENE_BASE:-origin/main}"
if git rev-parse --verify --quiet "$base" >/dev/null; then
  range="$base..HEAD"
else
  range="HEAD"
fi
messages="$(git log --format='%H%n%B' "$range" 2>/dev/null || true)"
if [[ -n "$messages" ]]; then
  if grep -iqE 'co-authored-by|generated with|claude' <<<"$messages"; then
    report "attribution or assistant name in commit messages ($range)"
  fi
  if [[ -s "$denylist" ]] && grep -iqFf "$denylist" <<<"$messages"; then
    report "blocked word in commit messages ($range)"
  fi
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "hygiene: clean"
