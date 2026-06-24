# ZeroFrame — Architecture & Contracts

This document is the technical reference for contributors: the design constraints, the
data-flow, the shared job-state contract, and the repository layout. For setup and usage,
see the [README](../README.md).

> **Context on 0G Compute.** 0G Compute is an inference-serving marketplace (chat /
> text-to-image / speech-to-text via an OpenAI-compatible API), **not** an
> arbitrary-container batch scheduler — you cannot submit a Docker image running
> ffmpeg/YOLO to it. So the computer-vision pipeline runs on infrastructure **we** control;
> 0G Compute's role is the per-clip caption inference call.

---

## Design constraints

These are the non-negotiable boundaries the codebase is built around.

1. **FastAPI stays a thin orchestration layer.** It mints a `job_id`, enqueues to Redis,
   and reads status back. It must never import `ultralytics`, `cv2`, `librosa`, or
   `ffmpeg`. The one forced deviation: `POST /upload` receives the raw video and shells out
   to the Go `0g-storage-client` CLI (the browser TS SDK reverts on Galileo — see #3). The
   file is streamed to a temp path and deleted after; no ML/video libraries are imported,
   it only runs a subprocess.

2. **All heavy lifting runs in a separate worker, never in the API process.** ffmpeg,
   YOLOv8, librosa, clip splicing, 0G Storage uploads, and the 0G Compute caption call all
   happen inside the worker — a separate deployment from the API — so the web process never
   imports the heavy ML stack. Two interchangeable dispatch paths realize this:
   - **Local / self-hosted:** Redis + RQ. FastAPI enqueues by **string reference**
     (`"worker.process_video_job"`); a long-running RQ worker picks it up. This is what
     `docker compose up` runs.
   - **Production (free tier):** the same `run_pipeline` runs as a serverless GPU container
     on **Modal**, triggered by an HTTP call from FastAPI instead of an RQ enqueue. The
     worker still writes results back to the same Redis job key, so the [job-state
     contract](#job-state-contract) below is identical on both paths. See
     [DEPLOYMENT.md](DEPLOYMENT.md).

3. **Uploads go through the backend Go CLI, not the browser SDK.** The browser
   `@0glabs/0g-ts-sdk` `indexer.upload()` reverts on the Galileo Flow contract (gasUsed
   pinned at 80% of the limit → `CALL_EXCEPTION`, likely a stale SDK ABI). The Go
   `0g-storage-client` uploads reliably (~292k gas). So `DropZone` POSTs the file to
   `POST /upload`, which runs the Go CLI and returns the merkle root. `frontend/lib/zg.ts`
   is kept for reference but is no longer on the upload path.

4. **ffmpeg always uses input seeking.** `-ss` must appear **before** `-i` (input seeking,
   not output seeking, which forces a full sequential read). Note: the worker does **not**
   stream from the gateway during splicing — `run_pipeline` calls
   `storage_client.download_video()` to pull the whole file to local disk first (librosa /
   audioread cannot read an HTTP URL), then ffmpeg input-seeks that local copy. HTTP Range
   requests only happen later, at browser clip playback (the `<video>` element hitting the
   indexer `/file?root=` endpoint).

5. **Async communication is polling, not WebSocket.** The frontend calls
   `GET /status/{job_id}` every 3 seconds and renders from the response.

6. **Storage fees are handled by the upload client, not hand-rolled.** The upload path
   relies on the client's own fee + gas handling; do not manually attach `value`.

---

## Data flow

```
Browser
  │
  ├─[1]─ POST /upload (multipart/form-data, raw file) ──────► FastAPI
  │       FastAPI streams the file to a temp path and shells out to the Go
  │       `0g-storage-client` CLI. Returns { root_hash, storage_cid, tx_hash, chunks }.
  │
  ├─[2]─ POST /process { root_hash, storage_cid } ──────────► FastAPI
  │       FastAPI mints job_id, writes "pending" to Redis,
  │       dispatches the worker (RQ enqueue locally / Modal HTTP trigger in prod),
  │       returns { job_id } immediately (non-blocking)
  │
  ├─[3]─ GET /status/{job_id} (poll every 3s) ─────────────► FastAPI
  │       FastAPI reads the Redis key zf:job:{job_id}
  │       returns { status, clip_cids, captions, compute_ids, windows }
  │
  └─[4]─ render ClipCards from clip_cids + captions
          each clip is served directly from the 0G Storage gateway
          (no video bytes pass through FastAPI at status/playback time)

Inside the worker (RQ process locally / Modal function in prod; reads/writes Redis):
  set status=processing
  download the full video from the 0G gateway to local disk (librosa needs a local file)
  librosa audio RMS (global-median baseline, ZF_AUDIO_SPIKE_RATIO) → candidate windows
  YOLOv8 refine pass (anchor-gated; see "Known limitations")
  ffmpeg input-seek splice per window over the local file → clip_N.mp4
  upload each clip → 0G Storage → collect CIDs
  per clip: 0G Compute Router caption from event metadata → collect response ids
  set status=complete, write { clip_cids, captions, compute_ids, event_count,
                               processing_ms, windows }
  on exception: set status=failed, write { error }
```

---

## Job-state contract

Redis key `zf:job:{job_id}` holds a single JSON object, **written by the worker** and
**read by the backend**. Both sides must keep this schema in sync.

| Key             | Type     | Notes                                                        |
|-----------------|----------|--------------------------------------------------------------|
| `status`        | string   | `pending` → `processing` → `complete` \| `failed`            |
| `clip_cids`     | `[str]`  | one CID per highlight clip                                   |
| `captions`      | `[str]`  | aligned by index; from 0G Compute                            |
| `compute_ids`   | `[str]`  | aligned by index; 0G Compute response ids                    |
| `event_count`   | int      |                                                              |
| `processing_ms` | int      |                                                              |
| `windows`       | `[obj]`  | `{ start_ts, end_ts, trigger, confidence }`                  |
| `error`         | str/null |                                                              |

---

## Proof surface (honest labeling)

The UI displays only what is genuinely verifiable, and labels each artifact for what it
actually is:

- **Merkle root / Storage CID** — root content identifier of the uploaded footage on 0G
  Storage (the merkle root is the CID).
- **Clip CID** — CID of each highlight clip on 0G Storage.
- **Caption** — produced via the 0G Compute Router (`router-api.0g.ai/v1`,
  OpenAI-compatible). The model is a text model: the caption is grounded in the detector's
  event signals, not the video pixels.
- **0G Compute response ID** — the `chatcmpl-…` id returned by the Router inference call.
  This is the verifiable compute artifact. Full on-chain TEE settlement
  (`getRequestHeaders` → `processResponse`) is broker-SDK / TypeScript-only and out of
  scope for the Python worker, so the TEE flag is treated as a vendor-reported value, not
  an on-chain settlement proof.

---

## Known limitations

- **Detection is audio-only in practice.** The YOLOv8 ball-confirmation pass
  (`detect.refine_window`) almost never fires on real broadcast footage (the ball is too
  small/blurry to clear the confidence threshold in the goal zone), so it contributes
  little while consuming CPU. The audio RMS anchor (global-median baseline,
  `ZF_AUDIO_SPIKE_RATIO`) carries detection in practice. Validated on a real 2-minute clip:
  it isolated both goals and ignored midfield. Not yet a robust multimodal engine.
- **Hard-crash recovery is minimal.** A SIGKILL/OOM mid-job leaves the Redis state at
  `processing` until a 24h TTL clears it. A future `on_failure` hook + heartbeat would fix
  this.
- librosa reads audio via the `audioread`/ffmpeg path (works; deprecated upstream).

---

## Repository structure

```
zeroframe/
├── frontend/                   ← Next.js app (TypeScript, Tailwind, Framer Motion)
│   ├── app/
│   │   ├── page.tsx            ← drop zone + upload flow
│   │   ├── status/[jobId]/     ← polling UI + highlight player
│   │   └── layout.tsx
│   ├── components/
│   │   ├── DropZone.tsx        ← POSTs the file to /upload, emits merkle root
│   │   ├── PipelineViz.tsx     ← animated pipeline stages
│   │   ├── ClipCard.tsx        ← individual highlight clip with CID + compute proof
│   │   └── ProofBadge.tsx      ← displays merkle root / job id
│   ├── lib/zg.ts               ← 0G TypeScript SDK wrapper (reference only)
│   └── package.json
├── backend/                    ← FastAPI — pure orchestration, no ML deps
│   ├── main.py                 ← routes: /upload, /process, /status, /health
│   ├── compute_client.py       ← Redis job state + RQ enqueue
│   ├── uploader.py             ← 0G Storage upload via the Go CLI
│   └── requirements.txt
└── worker/                     ← self-hosted RQ worker (separate deployment)
    ├── worker.py               ← process_video_job(): RQ entrypoint, writes Redis state
    ├── detect.py               ← audio RMS + anchor-gated YOLOv8 event detection
    ├── splice.py               ← ffmpeg clip splicing (input seek)
    ├── caption.py              ← 0G Compute caption via the OpenAI client → Router API
    ├── storage_client.py       ← 0G Storage download + per-clip upload (Go CLI)
    ├── Dockerfile
    └── requirements.txt
```

---

## Key library versions

```
# frontend
@0glabs/0g-ts-sdk     latest
framer-motion         11.x
next                  14.x
tailwindcss           3.x

# backend (API) — no ML deps
fastapi               0.111.x
uvicorn               0.30.x
httpx                 0.27.x   (async client)
redis                 5.x      (job-state store)
rq                    1.16.x   (task queue — enqueue by string ref)

# worker only — never import these in the backend
ultralytics           8.x      (YOLOv8)
librosa               0.10.x
ffmpeg-python         0.2.0
openai                1.x      (0G Compute Router client)
redis + rq            (same versions; worker runs `rq worker zeroframe`)
```
