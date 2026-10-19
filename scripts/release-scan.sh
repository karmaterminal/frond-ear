#!/usr/bin/env bash
# Pre-public release scan (#35). Rerun it at the exact SHA that goes public, in a fresh clone.
#
#   scripts/release-scan.sh [--expect <sha>] [--no-check]
#
# Scans every ref the public will see: origin's branches and tags, and the pull request
# heads GitHub serves under refs/pull/*, which outlive deleted branches. Prints counts and
# locations, never a matched secret value or a full email address.
#
#   --expect <sha>  fail unless origin/main is exactly this commit
#   --no-check      skip `pnpm check` and run only `pnpm scan:credentials` at HEAD
#
# RELEASE_SCAN_KNOWN_IDS may name a file of real Discord IDs (one per line, kept outside the
# repository) that must appear nowhere in history.
#
# Exit status is 1 if any secret-shaped pattern, known ID or unexplained snowflake is found.
# `/home/` paths, private IPv4 addresses and author emails are reported, not failed: they are
# for a person to judge.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

EXPECT=""
CHECK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) EXPECT="${2:?--expect needs a sha}"; shift 2 ;;
    --no-check) CHECK=0; shift ;;
    *) echo "usage: scripts/release-scan.sh [--expect <sha>] [--no-check]" >&2; exit 2 ;;
  esac
done

FAIL=0
git fetch --quiet --prune --tags origin
git fetch --quiet origin '+refs/pull/*/head:refs/release-scan/pull/*' || true
REFS=(--remotes=origin --tags '--glob=refs/release-scan/pull/*')

MAIN="$(git rev-parse origin/main)"
echo "# frond-ear release scan"
echo
echo "- origin/main: \`$MAIN\`"
echo "- HEAD: \`$(git rev-parse HEAD)\`"
if [ -n "$EXPECT" ] && [ "$MAIN" != "$(git rev-parse "$EXPECT")" ]; then
  echo "- **origin/main is not the expected $EXPECT**"
  FAIL=1
fi
echo "- branches: $(git branch -r --list 'origin/*' | grep -vc -- '->'), tags: $(git tag | wc -l), pull request heads: $(git for-each-ref refs/release-scan/pull | wc -l)"
echo "- reachable commits: $(git rev-list "${REFS[@]}" | wc -l)"
echo

echo "## pnpm at HEAD"
echo
if [ "$CHECK" = 1 ]; then
  pnpm --silent check >/dev/null 2>&1 && echo "- pnpm check: pass" || { echo "- pnpm check: **FAIL**"; FAIL=1; }
else
  pnpm --silent scan:credentials >/dev/null 2>&1 && echo "- scan:credentials: pass" || { echo "- scan:credentials: **FAIL**"; FAIL=1; }
fi
echo

PATCH="$(mktemp)"
trap 'rm -f "$PATCH"; git for-each-ref --format="delete %(refname)" refs/release-scan | git update-ref --stdin' EXIT
# One line per patch line, prefixed with its commit, so a hit can be located without printing it.
git log "${REFS[@]}" -p --no-ext-diff --no-color --format='commit %H' |
  awk '/^commit [0-9a-f]{40}$/ { c = substr($2, 1, 10); next } { print c "\t" $0 }' >"$PATCH"

# count NAME REGEX FATAL: distinct values, then the commits and files that hold them.
count() {
  local hits
  hits="$(grep -E -- "$2" "$PATCH" || true)"
  local values commits
  values="$(printf '%s' "$hits" | cut -f2- | grep -oE -- "$2" | sort -u | grep -c . || true)"
  commits="$(printf '%s' "$hits" | cut -f1 | sort -u | grep -c . || true)"
  echo "| $1 | $values | $commits |"
  if [ "$3" = 1 ] && [ "$values" != 0 ]; then FAIL=1; fi
}

echo "## History patterns (all refs above)"
echo
echo "| Pattern | Distinct values | Commits |"
echo "| --- | --- | --- |"
count "Discord bot token" '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}|mfa\.[A-Za-z0-9_-]{20,}' 1
count "Discord webhook URL" 'discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+' 1
count "GitHub token" 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}' 1
count "Anthropic/OpenAI key" 'sk-(ant-)?[A-Za-z0-9_-]{20,}' 1
count "Slack token" 'xox[abprs]-[A-Za-z0-9-]{10,}' 1
count "AWS access key" 'AKIA[0-9A-Z]{16}' 1
count "Private key header" '-----BEGIN [A-Z ]*PRIVATE KEY-----' 1
count "/home/ path" '(^|[^A-Za-z0-9_})$])/home/[a-z_][a-z0-9_-]*' 0
count "Private IPv4" '(^|[^0-9.])(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.[0-9]{1,3}){2})($|[^0-9.])' 0
echo

# Snowflakes: 17-20 digit runs standing alone (not inside hex or base64). Fixtures use
# synthetic IDs, which have a run of six repeated digits (100000000000000001) or count up
# (123456789012345678); anything else needs a person to look at it.
echo "## Discord IDs"
echo
SNOW='(^|[^0-9A-Za-z_])[0-9]{17,20}($|[^0-9A-Za-z_])'
ALL="$(cut -f2- "$PATCH" | grep -oE -- "$SNOW" | grep -oE '[0-9]{17,20}' | sort -u || true)"
OTHER="$(printf '%s\n' "$ALL" | grep -E . | grep -vE '([0-9])\1{5}|123456789' || true)"
echo "- distinct 17–20 digit runs: $(printf '%s\n' "$ALL" | grep -c . || true)"
echo "- not synthetic-shaped: $(printf '%s\n' "$OTHER" | grep -c . || true)"
for id in $OTHER; do
  echo "  - \`${id:0:4}…${id: -4}\` in $(grep -F -- "$id" "$PATCH" | cut -f1 | sort -u | head -3 | tr '\n' ' ')"
  FAIL=1
done
if [ -n "${RELEASE_SCAN_KNOWN_IDS:-}" ]; then
  known=0
  while read -r id; do
    [ -z "$id" ] && continue
    if grep -qF -- "$id" "$PATCH"; then known=$((known + 1)); fi
  done <"$RELEASE_SCAN_KNOWN_IDS"
  echo "- known real IDs (from \$RELEASE_SCAN_KNOWN_IDS) found: $known"
  [ "$known" = 0 ] || FAIL=1
else
  echo "- known real IDs: not checked (set RELEASE_SCAN_KNOWN_IDS)"
fi
echo

echo "## Author and committer emails"
echo
echo "| Email (masked) | Commits |"
echo "| --- | --- |"
git log "${REFS[@]}" --format='%ae%n%ce' | sort | uniq -c | sort -rn |
  awk '{ split($2, a, "@"); printf "| `%s…@%s` | %d |\n", substr(a[1], 1, 3), a[2], $1 }'
echo

echo "## Branches"
echo
echo "| Branch | Merged into main |"
echo "| --- | --- |"
MERGED="$(git branch -r --merged origin/main --format='%(refname:short)')"
git branch -r --list 'origin/*' --format='%(refname:short)' | grep -v '^origin$' | grep -vx 'origin/HEAD' |
  while read -r branch; do
    if printf '%s\n' "$MERGED" | grep -qxF -- "$branch"; then m=yes; else m=no; fi
    echo "| \`${branch#origin/}\` | $m |"
  done
echo

[ "$FAIL" = 0 ] && echo "**Result: clean.**" || echo "**Result: needs a look (see above).**"
exit "$FAIL"
