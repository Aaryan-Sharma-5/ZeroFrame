"""
Self-hosted ZeroFrame worker.

This is NOT a 0G Compute container — 0G Compute can't run arbitrary code. It's a plain
RQ worker process (run with `rq worker zeroframe`) that pulls jobs the FastAPI API
enqueued, runs the local CV pipeline, uploads clips to 0G Storage, and calls 0G Compute's
inference Router for per-clip captions.

Job-state contract (Redis key `zf:job:{job_id}`, JSON) — kept in sync with
backend/compute_client.py:
  status        pending → processing → complete | failed
  clip_cids     [str]                 (one per highlight clip)
  captions      [str]                 (aligned by index; from 0G Compute)
  compute_ids   [str]                 (aligned by index; 0G Compute response ids)
  event_count   int
  processing_ms int
  windows       [{start_ts, end_ts, trigger, confidence}]
  error         str | None

Pipeline stages (see run_pipeline):
  fetch_video → detect_events → splice_clips → upload_clips → caption each clip
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

from caption import generate_caption
from detect import detect_events
from splice import splice_clips
from storage_client import download_video, upload_clips

# --- Redis job-state I/O (writer side) --------------------------------------
_JOB_KEY = "zf:job:{job_id}"
_JOB_TTL_SECONDS = 24 * 3600
_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is None:
        from redis import Redis
        url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
        _redis_client = Redis.from_url(url, decode_responses=True)
    return _redis_client


def _update_state(job_id: str, **updates) -> None:
    """Read-modify-write the job-state JSON so partial updates preserve other fields."""
    r = _redis()
    key = _JOB_KEY.format(job_id=job_id)
    raw = r.get(key)
    state = json.loads(raw) if raw else {}
    state.update(updates)
    r.set(key, json.dumps(state), ex=_JOB_TTL_SECONDS)


def _storage_node() -> str:
    return os.environ.get("ZG_STORAGE_NODE_URL") or os.environ["ZG_STORAGE_NODE"]


def run_pipeline(root_hash: str, storage_cid: str, storage_node: str) -> dict:
    t0 = time.time()

    # Stage 1 — download source to local disk. librosa/audioread can't read HTTP URLs,
    # so the whole pipeline runs against the local file (ffmpeg still input-seeks it).
    source_path = download_video(root_hash, storage_node)
    try:
        # Stage 2 — detect highlight events (audio anchors + anchor-gated vision)
        windows = detect_events(source_path)

        # Stage 3 — splice clips; ffmpeg input-seeks into the local file
        clip_results = splice_clips(source_path, windows)
    finally:
        # Free the (potentially large) source as soon as splicing is done.
        Path(source_path).unlink(missing_ok=True)

    # Stage 4 — upload clips to 0G Storage via the Go CLI, collect CIDs (clip_results order)
    clip_cids = upload_clips(clip_results, storage_node)

    # Stage 5 — 0G Compute caption per clip (best-effort; never raises). Aligned by index.
    captions: list[str] = []
    compute_ids: list[str] = []
    for clip in clip_results:
        caption, resp_id = generate_caption(
            clip.start_ts, clip.end_ts, clip.trigger, clip.confidence
        )
        captions.append(caption)
        compute_ids.append(resp_id)

    processing_ms = int((time.time() - t0) * 1000)

    return {
        "clip_cids": clip_cids,
        "captions": captions,
        "compute_ids": compute_ids,
        "event_count": len(clip_cids),
        "processing_ms": processing_ms,
        "windows": [
            {
                "start_ts": w.start_ts,
                "end_ts": w.end_ts,
                "trigger": w.trigger,
                "confidence": round(w.confidence, 3),
            }
            for w in windows
        ],
    }


def process_video_job(job_id: str, root_hash: str, storage_cid: str) -> dict:
    """
    RQ entrypoint. FastAPI enqueues this by string reference ("worker.process_video_job").
    Advances Redis state and re-raises on failure so RQ also records the failure.
    """
    _update_state(job_id, status="processing")
    try:
        result = run_pipeline(root_hash, storage_cid, _storage_node())
        _update_state(job_id, status="complete", **result)
        return result
    except Exception as exc:
        _update_state(job_id, status="failed", error=str(exc))
        raise


def run_local_test(video_path: str) -> None:
    """
    Offline CV-only run: detect → splice. NO storage upload, NO 0G Compute caption.

    De-risks the entire ffmpeg/librosa/YOLO stack inside the container without needing
    any external credentials (A0GI funds, a live merkle root, or a Compute API key).
    If a local MP4 passes through and yields sane timestamps + non-empty clip files,
    ~90% of the worker logic is proven independent of the network.
    """
    import os.path

    t0 = time.time()
    print(f"[test] detecting events in {video_path} ...")
    windows = detect_events(video_path)
    print(f"[test] {len(windows)} event window(s) detected in {time.time() - t0:.1f}s")
    print(json.dumps([asdict(w) for w in windows], indent=2))

    # Exercise the ffmpeg splice path too (the other flaky-in-Docker step).
    clips = splice_clips(video_path, windows, output_dir="/tmp/zeroframe-test")
    for c in clips:
        size = os.path.getsize(c.local_path) if os.path.exists(c.local_path) else 0
        print(
            f"[test] clip {c.local_path}  {c.start_ts:.1f}-{c.end_ts:.1f}s "
            f"({c.trigger}, conf={c.confidence:.2f})  {size} bytes"
        )
    print(f"[test] OK — {len(clips)} clip(s) spliced. No upload, no caption. Exiting 0.")


def main() -> None:
    # --test <path>: offline CV pipeline (detect + splice), no network I/O. See run_local_test.
    if len(sys.argv) >= 3 and sys.argv[1] == "--test":
        run_local_test(sys.argv[2])
        return

    # Manual one-shot run from env (no queue) — handy for debugging the full pipeline.
    result = run_pipeline(
        os.environ["ROOT_HASH"], os.environ["STORAGE_CID"], _storage_node()
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
