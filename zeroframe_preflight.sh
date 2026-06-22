#!/usr/bin/env bash
# zeroframe_preflight.sh
# Run this GREEN before any judge watches the screen.
#
# Usage:  ./zeroframe_preflight.sh <path_to_demo_clip.mp4> [clip_cid_from_previous_run]
#
# Run it from the project root, in the environment where the worker deps actually live
# (Linux / WSL2 / the worker container) — step 3 imports cv2/librosa/ultralytics and the
# worker writes to /tmp, which do NOT exist on a bare Windows host.
#
# NOTE: NOT using `set -e`. A preflight must run EVERY check and report all failures, not
# abort on the first one. We use explicit pass/fail accounting and exit with the fail count.
set -uo pipefail

CLIP="${1:-}"
SEED_CID="${2:-}"
API="${ZEROFRAME_API:-http://localhost:8000}"
REDIS="${REDIS_URL:-redis://localhost:6379/0}"
INDEXER="${ZG_STORAGE_NODE_URL:-https://indexer-storage-testnet-turbo.0g.ai}"
WORKER_TEST_DIR="/tmp/zeroframe-test"   # worker.py --test writes clips HERE (not /tmp/clips)
PASS=0; FAIL=0

# NOTE: PASS=$((PASS+1)) — NOT ((PASS++)). Under any arithmetic context, ((x++)) returns
# exit status 1 when x is 0 (post-increment yields the old value 0 -> "false"), which would
# have killed the original script via set -e on the very first ok(). This form never does.
ok()   { echo "  [ OK ] $*"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "-- $* --"; }

# ── 1. HEALTH ──────────────────────────────────────────────────────────────
hdr "1. Backend health"
if HEALTH=$(curl -sf "$API/health" 2>/dev/null); then
  if echo "$HEALTH" | python3 -c "import sys,json; h=json.load(sys.stdin); print('  redis_ok:',h.get('redis_ok')); print('  queued:  ',h.get('redis',{}).get('queued','N/A')); sys.exit(0 if h.get('redis')=={} or h.get('status')!='degraded' else 1)" ; then
    # /health returns {status, redis:{redis_ok,queued}, ...} — check the nested flag.
    if echo "$HEALTH" | grep -q '"redis_ok": *true'; then
      ok "Backend up, redis_ok=true"
    else
      fail "Backend up but redis_ok=false — Redis unreachable from the API"
    fi
  else
    fail "/health returned unparseable body: $HEALTH"
  fi
else
  fail "/health unreachable at $API — is FastAPI running on :8000?"
fi

# ── 2. RQ WORKER on the 'zeroframe' queue ────────────────────────────────────
hdr "2. RQ worker attached to 'zeroframe' queue"
# grep -c exits 1 on zero matches; `|| true` keeps it from short-circuiting under pipefail.
WORKER_LINES=$(rq info --url "$REDIS" 2>/dev/null | grep -ci "zeroframe" || true)
WORKER_LINES=${WORKER_LINES:-0}
if [ "$WORKER_LINES" -gt 0 ]; then
  ok "Something is listening on the zeroframe queue"
  echo "    (confirm a *worker*, not just the queue, with: rq info --url $REDIS)"
else
  fail "NO worker on 'zeroframe' — jobs park at pending forever and the UI times out at 5 min"
  echo "    Fix:  cd worker && rq worker zeroframe --url $REDIS &"
fi

# ── 3. OFFLINE DETECTION (no credentials needed) ─────────────────────────────
hdr "3. Offline detection + splice (worker.py --test)"
if [ -z "$CLIP" ]; then
  fail "No clip path given — pass one as arg 1 to exercise detection"
elif [ ! -f "$CLIP" ]; then
  fail "Clip not found: $CLIP"
else
  rm -rf "$WORKER_TEST_DIR" 2>/dev/null || true
  # run_local_test prints human lines like "[test] 2 event window(s) detected ...".
  # It does NOT emit a JSON dict with event_count — parse the human line instead.
  TEST_OUT=$(python3 worker/worker.py --test "$CLIP" 2>&1 || true)
  EVENT_COUNT=$(echo "$TEST_OUT" | grep -oE '[0-9]+ event window' | grep -oE '^[0-9]+' | head -1)
  EVENT_COUNT=${EVENT_COUNT:-0}
  if [ "$EVENT_COUNT" -gt 0 ]; then
    ok "Detection found $EVENT_COUNT window(s)"
    echo "$TEST_OUT" | grep -E '^\[test\] clip' | sed 's/^/    /'
    # Each spliced clip must be playable with non-zero duration.
    shopt -s nullglob
    CLIPS=("$WORKER_TEST_DIR"/clip_*.mp4)
    shopt -u nullglob
    if [ "${#CLIPS[@]}" -eq 0 ]; then
      fail "Detection reported windows but no clip files in $WORKER_TEST_DIR"
    fi
    for CP in "${CLIPS[@]}"; do
      DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CP" 2>/dev/null || echo 0)
      HASV=$(ffprobe -v error -select_streams v -show_entries stream=codec_type -of csv=p=0 "$CP" 2>/dev/null | head -1)
      if python3 -c "import sys; sys.exit(0 if float('${DUR:-0}' or 0) > 0.5 else 1)" 2>/dev/null && [ "$HASV" = "video" ]; then
        ok "  $(basename "$CP"): ${DUR}s, has video stream"
      else
        fail "  $(basename "$CP"): bad clip (dur=${DUR:-?}, video_stream=${HASV:-none}) — ffmpeg -c copy may have landed off a keyframe"
      fi
    done
  else
    fail "ZERO detection windows — the demo would show a green checkmark over an EMPTY grid"
    echo "    1. Lower ZF_AUDIO_SPIKE_RATIO to 1.5 in backend/.env (read at runtime, no rebuild)"
    echo "    2. Use a source with real crowd noise; broadcast mixes are loudness-normalized"
    echo "    3. Remember the 5s <= window <= 90s filter silently drops everything else"
    echo "    --- worker --test output ---"
    echo "$TEST_OUT" | sed 's/^/    /'
  fi
fi

# ── 4. END-TO-END UPLOAD (small clip only) ───────────────────────────────────
hdr "4. End-to-end /upload (use a <50 MB clip)"
CID="$SEED_CID"
if [ -z "$CLIP" ] || [ ! -f "$CLIP" ]; then
  fail "No usable clip — skipping upload"
else
  SIZE=$(stat -c%s "$CLIP" 2>/dev/null || stat -f%z "$CLIP" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 52428800 ]; then
    fail "Clip is $(( SIZE / 1048576 )) MB — testnet upload will stall/revert. Use <50 MB for preflight."
  else
    UPLOAD=$(curl -sf -X POST "$API/upload" -F "file=@$CLIP" 2>/dev/null || true)
    ROOT=$(echo "$UPLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('root_hash',''))" 2>/dev/null || true)
    if echo "$ROOT" | grep -qE '^0x[0-9a-fA-F]{64}$'; then
      ok "Upload returned valid root_hash: ${ROOT:0:14}...${ROOT: -6}"
      CID="$ROOT"
    else
      fail "Upload failed or malformed response: ${UPLOAD:-<empty>}"
    fi
  fi
fi

# ── 5. GATEWAY 206 / CORS / content-type on a real CID ───────────────────────
hdr "5. Clip playback: 206 Range + CORS + content-type"
if [ -z "$CID" ]; then
  fail "No CID available — pass one as arg 2, or fix step 4 so a fresh root is captured"
else
  HEADERS=$(curl -sI -H "Range: bytes=0-1023" -H "Origin: http://localhost:3000" \
            "$INDEXER/file?root=$CID" 2>/dev/null || true)
  echo "$HEADERS" | grep -qiE '^HTTP/.* 206' \
    && ok "206 Partial Content" \
    || fail "No 206 — gateway won't serve byte ranges for this CID (video element seeks will break)"
  echo "$HEADERS" | grep -qi 'access-control-allow-origin' \
    && ok "CORS header present" \
    || fail "No Access-Control-Allow-Origin — browser falls back to the text link, NO inline video"
  if echo "$HEADERS" | grep -qi '^content-type: *video'; then
    ok "Content-Type is video/*"
  else
    CT=$(echo "$HEADERS" | grep -i '^content-type' | tr -d '\r')
    fail "Wrong content-type (${CT:-none}) — browsers won't play it inline"
  fi
fi

# ── 6. 0G COMPUTE caption + TEE flag (honest check) ──────────────────────────
hdr "6. 0G Compute caption / TEE flag (vendor-reported, NOT cryptographic proof)"
# Container name varies by compose project; try a couple, fall back to compose logs.
WLOGS=""
for NAME in zeroframe-worker zeroframe-worker-1 worker; do
  WLOGS=$(docker logs "$NAME" 2>/dev/null) && [ -n "$WLOGS" ] && break
done
[ -z "$WLOGS" ] && WLOGS=$(docker compose logs worker 2>/dev/null || true)
if [ -z "$WLOGS" ]; then
  fail "No worker logs found (tried docker logs / docker compose logs worker) — can't verify captioning"
elif echo "$WLOGS" | grep -q "0G Compute caption failed"; then
  fail "Caption FELL BACK to deterministic text — compute_id empty, NO badge renders"
  echo "    Check ZG_COMPUTE_API_KEY, minimax-m3 reachability, 15s timeout, extra_body acceptance"
elif echo "$WLOGS" | grep -q "tee_verified=true"; then
  ok "tee_verified=true seen — badge WILL render"
  echo "    REMINDER: label it '0G Compute response ID', NOT 'cryptographic proof' (vendor-reported)"
else
  fail "No tee_verified in logs — minimax-m3 may not return x_0g_trace.tee_verified; badge stays hidden"
fi

# ── 7. WORKER PLATFORM (Linux paths) ─────────────────────────────────────────
hdr "7. Worker platform (hardcoded /tmp and /app/models are Linux-only)"
if docker ps 2>/dev/null | grep -qiE 'zeroframe.*worker|worker'; then
  ok "Worker running in a Docker container"
elif grep -qi microsoft /proc/version 2>/dev/null; then
  ok "Running under WSL — Linux paths resolve"
else
  fail "Worker looks like it's on a bare Windows host — /tmp and /app/models will not exist"
  echo "    Fix: run the worker in Docker or WSL2"
fi

# ── SUMMARY ──────────────────────────────────────────────────────────────────
echo
echo "==================================="
echo "  PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  Stack is demo-ready."
else
  echo "  Fix all [FAIL] items before presenting."
fi
echo "==================================="
exit "$FAIL"
