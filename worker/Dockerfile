# --- Stage 1: build the official Go 0g-storage-client CLI -------------------
# We upload clips via this binary (most battle-tested 0G Storage client) rather
# than an immature Python SDK. See storage_client.py.
FROM golang:1.24-bookworm AS zgbuilder
RUN git clone --depth 1 https://github.com/0glabs/0g-storage-client.git /src \
    && cd /src \
    && go build -o /out/0g-storage-client . \
    && /out/0g-storage-client --help >/dev/null

# --- Stage 2: the worker runtime --------------------------------------------
FROM python:3.11-slim
RUN apt-get update && apt-get install -y ffmpeg libsndfile1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Bring in the Go CLI binary on PATH
COPY --from=zgbuilder /out/0g-storage-client /usr/local/bin/0g-storage-client

COPY requirements.txt .
# Install CPU-only torch FIRST so ultralytics doesn't pull the multi-GB CUDA build.
# torch 2.2.2 also keeps torch.load(weights_only=False) as the default, which
# ultralytics 8.2.0 relies on to deserialize yolov8n.pt (torch >=2.6 broke this).
RUN pip install --no-cache-dir torch==2.2.2 torchvision==0.17.2 \
        --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
# Bake YOLOv8n weights into the image so the worker never downloads at runtime.
# ultralytics downloads a bare 'yolov8n.pt' into the CWD, so cd into the target dir first.
# /app/models/yolov8n.pt is also detect.py's default MODEL_PATH.
RUN mkdir -p /app/models && cd /app/models \
    && python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" \
    && test -f /app/models/yolov8n.pt
ENV YOLO_MODEL_PATH=/app/models/yolov8n.pt
COPY . .
# RQ worker is the real entrypoint; docker-compose overrides as needed.
CMD ["rq", "worker", "zeroframe", "--url", "redis://redis:6379/0"]
