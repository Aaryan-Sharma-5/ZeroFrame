"""
Job orchestration for ZeroFrame — Redis-backed state + Modal HTTP dispatch.

This module is PURE orchestration. It writes job state to Redis and dispatches
the ML pipeline to Modal's serverless GPU function via HTTP. It never imports
the worker's ML stack (ultralytics/cv2/librosa stay in the worker image only).

  submit_job()     → write "pending" state to Redis, POST to Modal trigger endpoint
  get_job_status() → read the job-state JSON the worker writes back
  healthcheck()    → Redis ping

The Modal trigger endpoint returns immediately (fire-and-forget); the GPU pipeline
runs asynchronously in Modal's cloud and writes results back to Redis when done.
"""
import json
import logging
import os
from typing import Any, Optional

import httpx
from redis import Redis
from redis.exceptions import RedisError

from config import settings

logger = logging.getLogger(__name__)

# Shared job-state contract. Keep in sync with worker/worker.py.
_JOB_KEY = "zf:job:{job_id}"
_JOB_TTL_SECONDS = 24 * 3600

_redis = Redis.from_url(settings.redis_url, decode_responses=True)

# Modal trigger URL — printed by `modal deploy worker/modal_worker.py`.
# Set as MODAL_ENDPOINT in Render dashboard.
_MODAL_ENDPOINT = os.environ.get("MODAL_ENDPOINT", "")
_MODAL_TOKEN_ID = os.environ.get("MODAL_TOKEN_ID", "")


def _key(job_id: str) -> str:
    return _JOB_KEY.format(job_id=job_id)


def _initial_state() -> dict[str, Any]:
    return {
        "status": "pending",
        "clip_cids": [],
        "captions": [],
        "compute_ids": [],
        "event_count": 0,
        "processing_ms": 0,
        "windows": [],
        "error": None,
    }


def submit_job(job_id: str, root_hash: str, storage_cid: str) -> None:
    """
    Write pending state to Redis, then dispatch to Modal trigger endpoint via HTTP.

    Owning the id end-to-end (mint → Redis write → Modal spawn → worker writes back
    under the same key) eliminates any poll-before-worker-starts 404 race.

    Raises:
        RuntimeError  — MODAL_ENDPOINT env var not set (misconfiguration)
        RedisError    — Redis unreachable (surfaces as 503)
        httpx.HTTPError — Modal endpoint returned a non-2xx status
    """
    if not _MODAL_ENDPOINT:
        raise RuntimeError("MODAL_ENDPOINT env var is not set — run `modal deploy` first")

    # Write pending state first so /status never returns 404 for a known job_id.
    _redis.set(_key(job_id), json.dumps(_initial_state()), ex=_JOB_TTL_SECONDS)

    # POST to Modal trigger — returns immediately (Modal spawns the GPU function async).
    headers = {}
    if _MODAL_TOKEN_ID:
        headers["Modal-Key"] = _MODAL_TOKEN_ID

    with httpx.Client(timeout=15) as client:
        resp = client.post(
            _MODAL_ENDPOINT,
            json={"job_id": job_id, "root_hash": root_hash, "storage_cid": storage_cid},
            headers=headers,
        )
        resp.raise_for_status()

    logger.info("Dispatched job %s to Modal (storage_cid=%s)", job_id, storage_cid)


def get_job_status(job_id: str) -> Optional[dict[str, Any]]:
    """Read job state from Redis. Returns None (→ 404) if the id is unknown/expired."""
    raw = _redis.get(_key(job_id))
    if raw is None:
        return None
    return {"job_id": job_id, **json.loads(raw)}


def healthcheck() -> dict[str, Any]:
    """Liveness of the Redis backbone and Modal configuration for /health."""
    try:
        _redis.ping()
        return {"redis_ok": True, "modal_configured": bool(_MODAL_ENDPOINT)}
    except RedisError as exc:
        logger.warning("Redis ping failed: %s", exc)
        return {"redis_ok": False, "modal_configured": bool(_MODAL_ENDPOINT)}
