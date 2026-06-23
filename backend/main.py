import asyncio
import logging
import os
import re
import tempfile
import uuid
from typing import Literal

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from redis.exceptions import RedisError

import compute_client
import uploader

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="ZeroFrame API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def keep_alive():
    """
    Ping /health every 10 minutes to prevent Render free-tier sleep.
    Render injects RENDER_EXTERNAL_URL automatically; absent in local dev so this
    becomes a no-op when running via docker compose.
    """
    async def _ping():
        url = os.environ.get("RENDER_EXTERNAL_URL", "")
        if not url:
            return
        await asyncio.sleep(60)  # wait for full startup before first ping
        async with httpx.AsyncClient() as client:
            while True:
                try:
                    await client.get(f"{url}/health", timeout=5)
                except Exception:
                    pass
                await asyncio.sleep(600)  # every 10 minutes

    asyncio.create_task(_ping())

_ROOT_HASH_RE = re.compile(r"^0x[a-fA-F0-9]{64}$")

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ProcessRequest(BaseModel):
    root_hash: str
    storage_cid: str
    filename: str = "video.mp4"

    @field_validator("root_hash")
    @classmethod
    def validate_root_hash(cls, v: str) -> str:
        if not _ROOT_HASH_RE.match(v):
            raise ValueError("root_hash must be a 0x-prefixed 64-character hex string")
        return v


class ProcessResponse(BaseModel):
    job_id: str
    status: str


class StatusResponse(BaseModel):
    job_id: str
    status: Literal["pending", "processing", "complete", "failed"]
    clip_cids: list[str]
    captions: list[str] = []       # one per clip_cid, aligned by index (0G Compute output)
    compute_ids: list[str] = []    # 0G Compute Router response ids, aligned by index
    event_count: int
    processing_ms: int
    error: str | None = None
    windows: list[dict] = []   # passthrough from worker: [{start_ts, end_ts, trigger, confidence}]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Accept a video from the browser and upload it to 0G Storage via the Go CLI, returning
    the merkle root. The browser TS SDK reverts on Galileo, so the upload runs server-side
    (a documented deviation from "FastAPI never touches video"). The file is streamed to a
    temp path and removed after; the heavy 0G upload runs off the event loop.
    """
    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
        result = await asyncio.to_thread(uploader.upload_to_0g, tmp_path)
    except Exception as exc:
        logger.error("Upload failed for %s: %s", file.filename, exc)
        raise HTTPException(status_code=502, detail=f"0G Storage upload failed: {exc}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    logger.info("Uploaded %s → %s", file.filename, result["root_hash"])
    return result


@app.post("/process", response_model=ProcessResponse)
async def process_video(body: ProcessRequest):
    """
    Accept upload metadata from the browser, enqueue a worker job, return job_id.

    We mint the id here and own it end-to-end: it is the Redis key AND the RQ job id,
    so a poll that arrives before the worker starts sees "pending", never a 404.
    """
    job_id = f"zf-{uuid.uuid4().hex}"

    # submit_job is a quick Redis SET + enqueue; run off the event loop so a slow/down
    # Redis can never stall the API. Surfaces RedisError → 503 (not a silent failure).
    try:
        await asyncio.to_thread(
            compute_client.submit_job, job_id, body.root_hash, body.storage_cid
        )
    except RedisError as exc:
        logger.error("Redis unavailable for %s: %s", job_id, exc)
        raise HTTPException(status_code=503, detail=f"Job store unavailable: {exc}")
    except httpx.HTTPError as exc:
        logger.error("Modal dispatch failed for %s: %s", job_id, exc)
        raise HTTPException(status_code=502, detail=f"Worker dispatch failed: {exc}")
    except RuntimeError as exc:
        logger.error("Configuration error for %s: %s", job_id, exc)
        raise HTTPException(status_code=503, detail=str(exc))

    logger.info("Enqueued job %s file=%s", job_id, body.filename)
    return ProcessResponse(job_id=job_id, status="queued")


@app.get("/status/{job_id}", response_model=StatusResponse)
async def get_status(job_id: str):
    """
    Read job progress from Redis. Browser calls this every 3 seconds.
    """
    try:
        result = await asyncio.to_thread(compute_client.get_job_status, job_id)
    except RedisError as exc:
        raise HTTPException(status_code=503, detail=f"Job store unavailable: {exc}")

    if result is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")

    response = JSONResponse(content=StatusResponse(**result).model_dump())
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
async def health():
    backbone = await asyncio.to_thread(compute_client.healthcheck)
    return {
        "status": "ok" if backbone["redis_ok"] else "degraded",
        "redis": backbone,
        "zg_storage_node": compute_client.settings.zg_storage_node_url,
        "version": "1.0.0-group-stage",
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
