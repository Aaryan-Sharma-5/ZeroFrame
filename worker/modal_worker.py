"""
Modal worker for ZeroFrame — compatible with Modal 1.x.

Deploy with (from project root):
    modal deploy worker/modal_worker.py

modal.Mount was removed in Modal 1.x. Local worker source is now embedded into
the container image via .copy_local_dir(), which is cheaper (no per-invocation
file sync) and simpler. The copy step is placed LAST in the image build chain so
that changing worker Python files doesn't invalidate the expensive YOLO-bake cache.

This creates two endpoints:
  - trigger (web endpoint, no GPU) → accepts POST from FastAPI, spawns pipeline, returns immediately
  - run_pipeline (T4 GPU, 5 min) → full ML pipeline, writes result back to Render Redis
"""

import modal

app = modal.App("zeroframe-worker")

# ---------------------------------------------------------------------------
# Container image — built once, reused across cold starts
# ---------------------------------------------------------------------------
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "libgl1", "libglib2.0-0", "git", "curl")
    # Build the official 0g-storage-client Go CLI — same as the worker Dockerfile.
    # The binary is copied to /usr/local/bin; Go toolchain is removed afterwards to save space.
    .run_commands(
        "curl -fsSL https://go.dev/dl/go1.24.0.linux-amd64.tar.gz -o /tmp/go.tar.gz "
        "&& tar -C /usr/local -xzf /tmp/go.tar.gz "
        "&& rm /tmp/go.tar.gz "
        "&& git clone --depth 1 https://github.com/0glabs/0g-storage-client.git /tmp/0g-src "
        "&& cd /tmp/0g-src "
        "&& /usr/local/go/bin/go build -o /usr/local/bin/0g-storage-client . "
        "&& /usr/local/bin/0g-storage-client --help > /dev/null "
        "&& rm -rf /tmp/0g-src /usr/local/go"
    )
    # CPU-only torch FIRST — prevents ultralytics pulling the multi-GB CUDA build.
    # torch 2.2.2 keeps weights_only=False default that ultralytics 8.2.0 requires.
    .run_commands(
        "pip install --no-cache-dir torch==2.2.2 torchvision==0.17.2 "
        "--index-url https://download.pytorch.org/whl/cpu"
    )
    .pip_install_from_requirements("worker/requirements.txt")
    # fastapi[standard] is required explicitly for @modal.fastapi_endpoint (Modal 1.x).
    .pip_install("fastapi[standard]")
    # Bake YOLOv8n weights into the image — never downloads at runtime.
    # /app/models/yolov8n.pt matches YOLO_MODEL_PATH and detect.py's default MODEL_PATH.
    .run_commands(
        "mkdir -p /app/models "
        "&& cd /app/models "
        "&& python -c \"from ultralytics import YOLO; YOLO('yolov8n.pt')\" "
        "&& test -f /app/models/yolov8n.pt"
    )
    # env() must come before add_local_dir — Modal forbids build steps after add_local_*.
    .env({"YOLO_MODEL_PATH": "/app/models/yolov8n.pt"})
    # add_local_dir MUST be last: Modal injects local files at container startup (not build
    # time), so any build step after it is an error. Includes worker.py, detect.py, etc.
    .add_local_dir("worker", remote_path="/app")
)

secrets = [modal.Secret.from_name("zeroframe-secrets")]


# ---------------------------------------------------------------------------
# GPU pipeline function
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="T4",
    timeout=300,          # 5-minute ceiling
    secrets=secrets,
    retries=0,            # fail fast for the demo, don't retry
)
def run_pipeline(job_id: str, root_hash: str, storage_cid: str) -> dict:
    """
    Full ML pipeline: download → detect → splice → upload → caption.
    Writes job state to Render Redis at each stage (REDIS_URL comes from the Modal secret).
    """
    import sys
    sys.path.insert(0, "/app")
    from worker import process_video_job  # noqa: E402
    return process_video_job(job_id, root_hash, storage_cid)


# ---------------------------------------------------------------------------
# HTTP trigger — no GPU, returns immediately, spawns the pipeline
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    secrets=secrets,
)
@modal.fastapi_endpoint(method="POST")
def trigger(item: dict) -> dict:
    """
    Lightweight web endpoint called by FastAPI POST /process.

    .spawn() submits run_pipeline to Modal's scheduler and returns immediately
    so FastAPI can return job_id to the browser in <1s.
    The browser polls GET /status/{job_id}; the worker writes results to Redis when done.
    """
    job_id: str = item["job_id"]
    root_hash: str = item["root_hash"]
    storage_cid: str = item["storage_cid"]

    run_pipeline.spawn(job_id, root_hash, storage_cid)

    return {"status": "accepted", "job_id": job_id}
