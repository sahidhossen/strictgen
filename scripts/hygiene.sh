#!/usr/bin/env bash
# Public hygiene check. Fails if the repo or its commit messages contain
# blocked words, internal files, likely secrets, attribution lines or stray files.
#
#   scripts/hygiene.sh            check the index and commit messages
#   scripts/hygiene.sh --text     check text on stdin (a PR title and body, an issue)
#
# Blocked words come from $HYGIENE_DENYLIST (newline separated) or a local,
# untracked .hygiene-denylist file. In CI ($CI set) a missing denylist is an
# error. Commit messages are checked from $HYGIENE_BASE to HEAD; unset means
# origin/main, empty means every commit reachable from HEAD.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
report() {
  echo "hygiene: $1" >&2
  fail=1
}

attribution='co-authored-by|generated with|claude'

denylist="$(mktemp)"
trap 'rm -f "$denylist"' EXIT
if [[ -n "${HYGIENE_DENYLIST:-}" ]]; then
  printf '%s\n' "$HYGIENE_DENYLIST" >"$denylist"
elif [[ -f .hygiene-denylist ]]; then
  cat .hygiene-denylist >"$denylist"
fi
# Drop carriage returns and blank lines.
tr -d '\r' <"$denylist" | grep -v '^[[:space:]]*$' >"$denylist.tmp" || true
mv "$denylist.tmp" "$denylist"
if [[ ! -s "$denylist" ]]; then
  if [[ -n "${CI:-}" ]]; then
    echo "hygiene: no denylist in CI, set the HYGIENE_DENYLIST secret" >&2
    exit 1
  fi
  echo "hygiene: no denylist found, skipping blocked-word checks" >&2
fi

if [[ "${1:-}" == "--text" ]]; then
  text="$(cat)"
  if grep -iqE "$attribution" <<<"$text"; then
    report "attribution or assistant name in text"
  fi
  if [[ -s "$denylist" ]] && grep -iqFf "$denylist" <<<"$text"; then
    report "blocked word in text"
  fi
  [[ $fail -eq 0 ]] && echo "hygiene: clean"
  exit $fail
fi

# Every path in the index, unquoted so non-ASCII names are checked as they are.
files="$(git -c core.quotePath=false ls-files --cached)"

# 1. Internal files that must never be tracked, at any depth, in any case.
internal='(^|/)(claude\.md|claude\.local\.md|\.claude/|\.local/|strictgen-spec\.md|\.hygiene-denylist)|\.local\.md$'
if hits="$(grep -iE "$internal" <<<"$files")"; then
  report "internal files are tracked:"$'\n'"$hits"
fi

# 2. Stray files.
stray='(^|/)(\.DS_Store|node_modules/|dist/|target/|coverage/)|\.log$|(^|/)\.env'
if hits="$(grep -E "$stray" <<<"$files")"; then
  report "stray files are tracked:"$'\n'"$hits"
fi

# Runs git grep over the index and reports matching files. Exit 1 from git grep
# means no match; anything above 1 is an error and fails the check.
scan() {
  local label="$1"
  shift
  local hits status=0
  hits="$(git -c core.quotePath=false grep --cached -l "$@")" || status=$?
  if [[ $status -gt 1 ]]; then
    report "git grep failed while checking for $label"
  elif [[ -n "$hits" ]]; then
    report "$label in:"$'\n'"$hits"
  fi
}

if [[ -s "$denylist" ]]; then
  # 3. Blocked words in file paths and contents (binary files included).
  if hits="$(grep -iFf "$denylist" <<<"$files")"; then
    report "blocked word in file paths:"$'\n'"$hits"
  fi
  scan "blocked word" -i -a -F -f "$denylist"
fi

# 4. Likely secrets.
scan "possible secret" -I -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16}'

# 5. Commit messages.
if [[ -z "${HYGIENE_BASE+set}" ]]; then
  base="origin/main"
else
  base="$HYGIENE_BASE"
fi
if ! git rev-parse --verify --quiet HEAD >/dev/null; then
  messages=""
elif [[ -z "$base" ]]; then
  messages="$(git log --format='%H%n%B' HEAD)"
elif git rev-parse --verify --quiet "$base" >/dev/null; then
  messages="$(git log --format='%H%n%B' "$base..HEAD")"
else
  report "commit range base $base not found"
  messages=""
fi
if [[ -n "$messages" ]]; then
  if grep -iqE "$attribution" <<<"$messages"; then
    report "attribution or assistant name in commit messages"
  fi
  if [[ -s "$denylist" ]] && grep -iqFf "$denylist" <<<"$messages"; then
    report "blocked word in commit messages"
  fi
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "hygiene: clean"
