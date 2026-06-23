# --- Stage 1: build the official Go 0g-storage-client CLI ---------------------
# /upload shells out to this (the browser TS SDK reverts on Galileo). Same binary the
# worker uses for clip uploads.
FROM golang:1.24-bookworm AS zgbuilder
RUN git clone --depth 1 https://github.com/0glabs/0g-storage-client.git /src \
    && cd /src \
    && go build -o /out/0g-storage-client . \
    && /out/0g-storage-client --help >/dev/null

# --- Stage 2: FastAPI API (pure orchestration + Go-CLI upload, no ML deps) -----
FROM python:3.11-slim
WORKDIR /app
COPY --from=zgbuilder /out/0g-storage-client /usr/local/bin/0g-storage-client
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
# Single worker keeps logs readable; state lives in Redis so it's not a correctness need.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000", "--workers", "1"]
