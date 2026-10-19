#!/usr/bin/env bash
# Pre-public release scan (#35). Rerun it at the exact SHA that goes public, in a fresh clone.
#
#   scripts/release-scan.sh [--expect <sha>] [--no-check]
#
# Scans every ref the public will see: origin's branches and tags, and the pull request
# heads GitHub serves under refs/pull/*, which outlive deleted branches. Merge commits are
# diffed against their first parent and binary blobs are read as text. Then, through gh, it
# scans the issue, pull request, comment and review text that goes public with the repo
# (GH_CONFIG_DIR defaults to ~/.config/gh-gloss when that exists). Prints counts and
# locations, never a matched secret value or a full email address.
#
#   --expect <sha>  fail unless both HEAD and origin/main are exactly this commit
#   --no-check      skip `pnpm check` and run only `pnpm scan:credentials` at HEAD
#
# RELEASE_SCAN_KNOWN_IDS may name a file of real Discord IDs (one per line, kept outside the
# repository) that must appear nowhere in history.
#
# Exit status is 1 if any secret-shaped pattern, known ID or unexplained snowflake is found,
# if --expect doesn't match HEAD and origin/main, or if pull request heads or conversations
# couldn't be read.
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
PATCH="$(mktemp)"
TALK="$(mktemp)"
trap 'rm -f "$PATCH" "$TALK"; git for-each-ref --format="delete %(refname)" refs/release-scan | git update-ref --stdin' EXIT
if ! git fetch --quiet --prune --tags origin; then
  echo "release-scan: fetching branches and tags from origin failed" >&2
  exit 1
fi
# Pull request heads are public and outlive deleted branches. A failed fetch would silently
# scan none of them, so it stops the scan, and the count is checked against the server's.
if ! git fetch --quiet origin '+refs/pull/*/head:refs/release-scan/pull/*'; then
  echo "release-scan: fetching refs/pull/*/head from origin failed; the pull request heads would go unscanned" >&2
  exit 1
fi
PULLS_SERVER="$(git ls-remote origin 'refs/pull/*/head' | wc -l)"
PULLS="$(git for-each-ref refs/release-scan/pull | wc -l)"
REFS=(--remotes=origin --tags '--glob=refs/release-scan/pull/*')

MAIN="$(git rev-parse origin/main)"
HEAD_SHA="$(git rev-parse HEAD)"
echo "# frond-ear release scan"
echo
echo "- origin/main: \`$MAIN\`"
echo "- HEAD: \`$HEAD_SHA\`"
if [ -n "$EXPECT" ]; then
  # The tree `pnpm check` tests is HEAD's, and what goes public is origin/main: both must be it.
  WANT="$(git rev-parse --verify --quiet "$EXPECT^{commit}" || true)"
  if [ -z "$WANT" ]; then
    echo "- **--expect $EXPECT is not a commit here**"
    FAIL=1
  else
    [ "$MAIN" = "$WANT" ] || { echo "- **origin/main is not the expected \`$WANT\`**"; FAIL=1; }
    [ "$HEAD_SHA" = "$WANT" ] || { echo "- **HEAD is not the expected \`$WANT\`**"; FAIL=1; }
  fi
fi
echo "- branches: $(git branch -r --list 'origin/*' | grep -vc -- '->'), tags: $(git tag | wc -l), pull request heads: $PULLS fetched of $PULLS_SERVER on origin"
if [ "$PULLS" != "$PULLS_SERVER" ]; then
  echo "- **pull request heads fetched ($PULLS) differ from origin's ($PULLS_SERVER)**"
  FAIL=1
fi
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

# One line per patch line, prefixed with its commit, so a hit can be located without printing it.
# Merges are diffed against their first parent, so a merge resolution is scanned too, and
# binary blobs are scanned as text.
git log "${REFS[@]}" -p --diff-merges=first-parent --text --no-ext-diff --no-color --format='commit %H' |
  awk '/^commit [0-9a-f]{40}$/ { c = substr($2, 1, 10); next } { print c "\t" $0 }' >"$PATCH"

# count FILE NAME REGEX FATAL: distinct values, then the places (first column) that hold them.
count() {
  local hits values places
  hits="$(grep -aE -- "$3" "$1" || true)"
  # Trim the boundary characters some patterns match, so `"/home/x` and ` /home/x` are one value.
  values="$(printf '%s' "$hits" | cut -f2- | grep -aoE -- "$3" | sed -E 's/^[^A-Za-z0-9/]//; s/[^A-Za-z0-9]$//' | sort -u | grep -c . || true)"
  places="$(printf '%s' "$hits" | cut -f1 | sort -u | grep -c . || true)"
  echo "| $2 | $values | $places |"
  if [ "$4" = 1 ] && [ "$values" != 0 ]; then FAIL=1; fi
}

# patterns FILE PLACES: the pattern table, then the Discord ID checks, over one dump.
patterns() {
  echo "| Pattern | Distinct values | $2 |"
  echo "| --- | --- | --- |"
  count "$1" "Discord bot token" '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}|mfa\.[A-Za-z0-9_-]{20,}' 1
  count "$1" "Discord webhook URL" 'discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+' 1
  count "$1" "GitHub token" 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}' 1
  count "$1" "Anthropic/OpenAI key" 'sk-(ant-)?[A-Za-z0-9_-]{20,}' 1
  count "$1" "Slack token" 'xox[abprs]-[A-Za-z0-9-]{10,}' 1
  count "$1" "AWS access key" 'AKIA[0-9A-Z]{16}' 1
  count "$1" "Private key header" '-----BEGIN [A-Z ]*PRIVATE KEY-----' 1
  count "$1" "/home/ path" '(^|[^A-Za-z0-9_})$])/home/[a-z_][a-z0-9_-]*' 0
  count "$1" "Private IPv4" '(^|[^0-9.])(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.[0-9]{1,3}){2})($|[^0-9.])' 0
  echo

  # Snowflakes: 17-20 digit runs standing alone (not inside hex or base64). Fixtures use
  # synthetic IDs, which have a run of six repeated digits (100000000000000001) or count up
  # (123456789012345678); anything else needs a person to look at it.
  # Split into word tokens first: matching the boundaries instead would consume the `/`
  # between two IDs in a guild/channel/message link and skip the second.
  local all other id known
  all="$(cut -f2- "$1" | grep -aoE '[0-9A-Za-z_]+' | grep -xE '[0-9]{17,20}' | sort -u || true)"
  other="$(printf '%s\n' "$all" | grep -E . | grep -vE '([0-9])\1{5}|123456789' || true)"
  echo "- distinct 17–20 digit runs: $(printf '%s\n' "$all" | grep -c . || true)"
  echo "- not synthetic-shaped: $(printf '%s\n' "$other" | grep -c . || true)"
  for id in $other; do
    echo "  - \`${id:0:4}…${id: -4}\` in $(grep -aF -- "$id" "$1" | cut -f1 | sort -u | head -3 | tr '\n' ' ')"
    FAIL=1
  done
  if [ -n "${RELEASE_SCAN_KNOWN_IDS:-}" ]; then
    known=0
    while read -r id; do
      [ -z "$id" ] && continue
      if grep -qaF -- "$id" "$1"; then known=$((known + 1)); fi
    done <"$RELEASE_SCAN_KNOWN_IDS"
    echo "- known real IDs (from \$RELEASE_SCAN_KNOWN_IDS) found: $known"
    [ "$known" = 0 ] || FAIL=1
  else
    echo "- known real IDs: not checked (set RELEASE_SCAN_KNOWN_IDS)"
  fi
  echo
}

echo "## History (all refs above)"
echo
patterns "$PATCH" "Commits"

# Binary files are scanned as text above, but a pattern can miss inside one; list them.
echo "## Binary paths"
echo
EMPTY_TREE="$(git hash-object -t tree /dev/null)"
with_binary=0
total_refs=0
while read -r ref; do
  total_refs=$((total_refs + 1))
  n="$(git diff --numstat "$EMPTY_TREE" "$ref" | awk -F'\t' '$1 == "-"' | wc -l)"
  if [ "$n" != 0 ]; then
    with_binary=$((with_binary + 1))
    echo "- \`${ref#refs/}\`: $n"
  fi
done < <(git for-each-ref --format='%(refname)' refs/remotes/origin refs/tags refs/release-scan/pull | grep -vx 'refs/remotes/origin/HEAD')
echo "- refs with binary paths in their tree: $with_binary of $total_refs"
echo "- distinct binary paths in history: $(git log "${REFS[@]}" --diff-merges=first-parent --numstat --format= | awk -F'\t' '$1 == "-" { print $3 }' | sort -u | grep -c . || true)"
echo

# Issues, pull requests and their comments and reviews go public with the repository too.
echo "## Conversations (issues, pull requests, comments, reviews)"
echo
SLUG="$(git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##')"
if [ -z "${GH_CONFIG_DIR:-}" ] && [ -d "$HOME/.config/gh-gloss" ]; then
  export GH_CONFIG_DIR="$HOME/.config/gh-gloss"
fi
# lines LABEL-EXPR: jq that turns each item into "<place>\t<line>" for every line of its text.
lines() { printf '.[] | (%s) as $p | ((.title // "") + "\\n" + (.body // "")) | split("\\n")[] | "\\($p)\\t\\(.)"' "$1"; }
fetch_talk() {
  local pr
  gh api --paginate "repos/$SLUG/issues?state=all&per_page=100" \
    --jq "$(lines 'if .pull_request then "pr#" else "issue#" end + (.number | tostring)')" || return 1
  gh api --paginate "repos/$SLUG/issues/comments?per_page=100" \
    --jq "$(lines '"comment:" + (.issue_url | split("/") | last)')" || return 1
  gh api --paginate "repos/$SLUG/pulls/comments?per_page=100" \
    --jq "$(lines '"review-line:" + (.pull_request_url | split("/") | last)')" || return 1
  for pr in $(gh api --paginate "repos/$SLUG/pulls?state=all&per_page=100" --jq '.[].number'); do
    gh api --paginate "repos/$SLUG/pulls/$pr/reviews?per_page=100" --jq "$(lines "\"review:$pr\"")" || return 1
  done
}
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "- **not covered: PR/issue/review text** (gh is missing or not signed in)"
  echo
elif ! fetch_talk >"$TALK"; then
  echo "- **not covered: PR/issue/review text** (a gh api call failed)"
  echo
  FAIL=1
else
  echo "- \`$SLUG\`: $(cut -f1 "$TALK" | sort -u | sed -E 's/[0-9]+$//' | uniq -c | awk '{ printf "%s%s %s", sep, $1, $2; sep = ", " }') places, $(wc -l <"$TALK") lines"
  echo
  patterns "$TALK" "Places"
fi

echo "## Author and committer emails"
echo
echo "| Email (masked) | Commits |"
echo "| --- | --- |"
git log "${REFS[@]}" --format='%H %ae%n%H %ce' | sort -u | cut -d' ' -f2 | sort | uniq -c | sort -rn |
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
