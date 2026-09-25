#!/usr/bin/env bash
# Runs frond-ear chaos proof rows with Grafana k6 against the chaos controller.
#
#   tools/chaos/run-proof.sh [artifact-dir] [row ...]
#
# Needs: k6 (v2.x) on PATH or K6_BIN, Node >= 22.18, dev dependencies installed.
# Never contacts real Discord or a real Claude session. Artifacts:
#   <artifact-dir>/RESULTS.md, RESOLVED-SHA.md, controller.log,
#   <ROW>/{k6-summary.json,receipt.json,ledger.json,k6.log}
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SHA="$(git rev-parse HEAD)"
DIRTY="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
OUT="${1:-$ROOT/artifacts/chaos/$SHA}"
shift || true
ROWS=("$@")
if [ ${#ROWS[@]} -eq 0 ]; then
  ROWS=(r-fe-replay r-fe-crash-queued r-fe-crash-unseen r-fe-shutdown-drain r-fe-revoke r-fe-kill-mid-send r-fe-drop-after-accept)
fi
K6="${K6_BIN:-k6}"
PORT="${FROND_EAR_CHAOS_PORT:-7788}"
mkdir -p "$OUT"
{
  echo "# Resolved identity"
  echo
  echo "- candidate SHA: \`$SHA\`"
  echo "- tracked-file modifications at run time: $DIRTY"
  echo "- node: $(node --version)"
  echo "- k6: $($K6 version | head -1)"
  echo "- started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/RESOLVED-SHA.md"

node tools/chaos/controller.ts --port "$PORT" > "$OUT/controller.log" 2>&1 &
CONTROLLER=$!
trap 'kill $CONTROLLER 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  grep -q "listening" "$OUT/controller.log" 2>/dev/null && break
  sleep 0.1
done

printf '| Row | Class | Verdict | Checks passed / failed |\n|---|---|---|---|\n' > "$OUT/RESULTS.md"
STATUS=0
for row in "${ROWS[@]}"; do
  ROW_ID="$(echo "$row" | tr '[:lower:]' '[:upper:]')"
  mkdir -p "$OUT/$ROW_ID"
  set +e
  "$K6" run --quiet \
    --env FROND_EAR_CHAOS_URL="http://127.0.0.1:$PORT" \
    --env FROND_EAR_ARTIFACT_DIR="$OUT" \
    --env FROND_EAR_CANDIDATE_SHA="$SHA" \
    "tools/chaos/scenarios/$row.js" > "$OUT/$ROW_ID/k6.log" 2>&1
  CODE=$?
  set -e
  [ $CODE -eq 0 ] || STATUS=1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const pass = r.checks.reduce((n, c) => n + c.passes, 0);
    const fail = r.checks.reduce((n, c) => n + c.fails, 0);
    console.log(`| ${r.row} | ${r.classification} | ${r.verdict} | ${pass} / ${fail} |`);
  ' "$OUT/$ROW_ID/receipt.json" >> "$OUT/RESULTS.md" || echo "| $ROW_ID | ? | ERROR (exit $CODE) | - |" >> "$OUT/RESULTS.md"
done
cat "$OUT/RESULTS.md"
exit $STATUS
