"""
Job orchestration for ZeroFrame — Redis-backed state + RQ enqueue.

This module is PURE orchestration. It does NOT call 0G Compute (no REST, no bearer
token — that shape was fictional). It does NOT import the worker's ML stack. It mints
nothing heavier than a Redis round-trip:

  submit_job()     → write "pending" state to Redis, enqueue the worker job by STRING
                     reference so this process never imports ultralytics/cv2/librosa.
  get_job_status() → read the job-state JSON the worker writes back.

The worker (separate process) owns the same Redis key `zf:job:{job_id}` and advances it
pending → processing → complete | failed. See worker/worker.py for the writer side.
"""
import json
import logging
from typing import Any, Optional

from redis import Redis
from redis.exceptions import RedisError
from rq import Queue

from config import settings

logger = logging.getLogger(__name__)

# Shared job-state contract. Keep in sync with worker/worker.py.
_JOB_KEY = "zf:job:{job_id}"
_JOB_TTL_SECONDS = 24 * 3600
_QUEUE_NAME = "zeroframe"
# String reference, NOT an import — keeps the heavy ML deps out of the API process.
_WORKER_JOB = "worker.process_video_job"

_redis = Redis.from_url(settings.redis_url, decode_responses=True)
_queue = Queue(_QUEUE_NAME, connection=_redis)


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
    Write the pending state and enqueue the worker job under the SAME job_id.

    Owning the id end-to-end (mint → enqueue → worker writes back under the same key)
    eliminates the old optimistic/real-id reconciliation bug entirely.

    Raises RedisError if the queue/store is unreachable — the caller surfaces 503.
    """
    _redis.set(_key(job_id), json.dumps(_initial_state()), ex=_JOB_TTL_SECONDS)
    _queue.enqueue(
        _WORKER_JOB,
        kwargs={"job_id": job_id, "root_hash": root_hash, "storage_cid": storage_cid},
        job_id=job_id,
        job_timeout=1800,        # 30 min ceiling for a long match
        result_ttl=_JOB_TTL_SECONDS,
        failure_ttl=_JOB_TTL_SECONDS,
    )
    logger.info("Enqueued job %s (storage_cid=%s)", job_id, storage_cid)


def get_job_status(job_id: str) -> Optional[dict[str, Any]]:
    """Read job state from Redis. Returns None (→ 404) if the id is unknown/expired."""
    raw = _redis.get(_key(job_id))
    if raw is None:
        return None
    return {"job_id": job_id, **json.loads(raw)}


def healthcheck() -> dict[str, Any]:
    """Liveness of the Redis/RQ backbone for /health."""
    try:
        _redis.ping()
        return {"redis_ok": True, "queued": _queue.count}
    except RedisError as exc:
        logger.warning("Redis ping failed: %s", exc)
        return {"redis_ok": False, "queued": None}
