#!/usr/bin/env bash
# Public hygiene check. Fails if the repo or its commit messages contain
# blocked words, internal files, likely secrets, attribution lines or stray files.
#
#   scripts/hygiene.sh            check the index and commit messages
#   scripts/hygiene.sh --text [file]   check text in a file, or on stdin without one (a PR
#                                      title and body, an issue). Empty text fails
#
# Blocked words come from $HYGIENE_DENYLIST (newline separated) or a local,
# untracked .hygiene-denylist file. A missing denylist is an error; set
# HYGIENE_ALLOW_NO_DENYLIST=1 to run the other checks without one (never in CI). Commit messages are checked from $HYGIENE_BASE to HEAD; unset means
# origin/main, empty means every commit reachable from HEAD.
set -euo pipefail

# Arguments first, so a bad call fails the same way with or without a denylist.
if [[ $# -gt 0 && "$1" != "--text" ]] || [[ $# -gt 2 ]]; then
  echo "hygiene: unknown argument ${@: -1} (usage: hygiene.sh [--text [file]])" >&2
  exit 2
fi

# Case-insensitive matching of non-ASCII words needs a UTF-8 locale.
if locale -a 2>/dev/null | grep -qiE '^c\.utf-?8$'; then
  export LC_ALL=C.UTF-8
else
  export LC_ALL=en_US.UTF-8
fi

# Work from the repository that holds this script, wherever it is run from.
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"

fail=0
report() {
  echo "hygiene: $1" >&2
  fail=1
}

attribution='co-authored-by|generated with|claude'
# GitHub adds this trailer to a squash merge when the pull request's commits carry the maintainer's
# noreply address and the merge is made under another of the maintainer's addresses. It names the
# maintainer, nobody else, so commit messages may hold it, and only this exact line.
owner_trailer='^co-authored-by: sahid hossen <12063077\+sahidhossen@users\.noreply\.github\.com>[[:space:]]*$'
# GitHub adds this one to a squash merge of a Dependabot pull request, whatever the merge message.
# It names the bot that wrote the commit, so it is allowed too, again only as this exact line.
bot_trailer='^co-authored-by: dependabot\[bot\] <49699333\+dependabot\[bot\]@users\.noreply\.github\.com>[[:space:]]*$'

denylist="$(mktemp)"
trap 'rm -f "$denylist"' EXIT
if [[ -n "${HYGIENE_DENYLIST:-}" ]]; then
  printf '%s\n' "$HYGIENE_DENYLIST" >"$denylist"
elif [[ -f .hygiene-denylist ]]; then
  cat .hygiene-denylist >"$denylist"
fi
# Drop carriage returns, surrounding whitespace and blank lines.
tr -d '\r' <"$denylist" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' >"$denylist.tmp" || true
mv "$denylist.tmp" "$denylist"
if [[ ! -s "$denylist" ]]; then
  if [[ -n "${CI:-}" ]]; then
    echo "hygiene: no denylist in CI, set the HYGIENE_DENYLIST secret" >&2
    exit 1
  fi
  if [[ "${HYGIENE_ALLOW_NO_DENYLIST:-}" != "1" ]]; then
    echo "hygiene: no denylist found (.hygiene-denylist or HYGIENE_DENYLIST); set HYGIENE_ALLOW_NO_DENYLIST=1 to skip blocked-word checks" >&2
    exit 1
  fi
  echo "hygiene: no denylist, skipping blocked-word checks (HYGIENE_ALLOW_NO_DENYLIST=1)" >&2
fi

if [[ "${1:-}" == "--text" ]]; then
  if [[ $# -eq 2 ]]; then
    if [[ ! -f "$2" || ! -r "$2" ]]; then
      echo "hygiene: can't read $2" >&2
      exit 2
    fi
    text="$(cat -- "$2")"
  else
    text="$(cat)"
  fi
  # Text that should be checked is never empty, so empty input means the text didn't arrive.
  if [[ -z "${text//[[:space:]]/}" ]]; then
    echo "hygiene: the text to check is empty" >&2
    exit 1
  fi
  if grep -iqE "$attribution" <<<"$text"; then
    report "attribution or assistant name in text"
  fi
  if [[ -s "$denylist" ]] && grep -iqFf "$denylist" <<<"$text"; then
    report "blocked word in text"
  fi
  [[ $fail -eq 0 ]] && echo "hygiene: clean"
  exit $fail
fi

# Every path in the index, raw (NUL separated, so git never quotes them).
files="$(git ls-files --cached -z | LC_ALL=C tr '\0' '\n')"

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
elif git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  messages="$(git log --format='%H%n%B' "$base..HEAD")"
else
  report "commit range base $base not found"
  messages=""
fi
if [[ -n "$messages" ]]; then
  if grep -viE "$owner_trailer|$bot_trailer" <<<"$messages" | grep -iqE "$attribution"; then
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
