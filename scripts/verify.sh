#!/usr/bin/env bash

set -u

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'verify')
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

CHECKS=(
  "test:npm test"
  "lint:npm run lint"
  "build:npm run build"
  "knip:npm run knip"
)

PIDS=()
NAMES=()

echo "Running verification checks in parallel (test, lint, build, knip)..."

for entry in "${CHECKS[@]}"; do
  NAME="${entry%%:*}"
  CMD="${entry#*:}"
  NAMES+=("$NAME")

  ($CMD > "$TMP_DIR/$NAME.log" 2>&1) &
  PIDS+=($!)
done

FAILED=0

# Wait for each process and record its exit code
for i in "${!PIDS[@]}"; do
  PID="${PIDS[$i]}"
  NAME="${NAMES[$i]}"
  wait "$PID"
  STATUS=$?
  echo "$STATUS" > "$TMP_DIR/$NAME.status"
  if [ "$STATUS" -ne 0 ]; then
    FAILED=1
  fi
done

echo ""
echo "================ Verification Report ================"

# Print results in order; print full log on failure
for NAME in "${NAMES[@]}"; do
  STATUS=$(cat "$TMP_DIR/$NAME.status")
  if [ "$STATUS" -eq 0 ]; then
    echo "  ✓ [PASS] $NAME"
  else
    echo "  ✗ [FAIL] $NAME (exit code: $STATUS)"
    echo "---------------- $NAME output ----------------"
    cat "$TMP_DIR/$NAME.log"
    echo "------------------------------------------------"
  fi
done

echo "====================================================="

if [ "$FAILED" -eq 0 ]; then
  echo "SUCCESS: All verification checks passed!"
  exit 0
else
  echo "FAILURE: One or more verification checks failed."
  exit 1
fi
