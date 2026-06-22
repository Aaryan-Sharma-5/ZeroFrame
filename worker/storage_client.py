"""
0G Storage helpers for the worker.

Uploads go through the official Go `0g-storage-client` CLI (baked into the worker image
by the Dockerfile) rather than an immature Python SDK — it's the most battle-tested 0G
Storage client and the path 0G themselves point to for production.

  fetch_video  — constructs the gateway download URL; video is never downloaded to disk.
  upload_clips — shells out to `0g-storage-client upload` per clip, parses the root hash,
                 retries on dropped uploads, and returns CIDs in clip_results order.

Env:
  ZG_RPC_URL              blockchain RPC (e.g. https://evmrpc-testnet.0g.ai)
  ZG_PRIVATE_KEY          wallet key that pays storage fees
  ZG_STORAGE_CLI          binary name/path (default: 0g-storage-client)
  ZG_STORAGE_CLI_EXTRA    extra args appended verbatim, space-split
                          (e.g. "--gas-limit 10000000" if Galileo estimateGas misbehaves)
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, List

import httpx

if TYPE_CHECKING:
    from splice import ClipResult

logger = logging.getLogger(__name__)

# The Go CLI emits logrus output with ANSI colour codes wrapping field names
# (e.g. "\x1b[36mroot\x1b[0m=0x..."), so strip those before matching. The merkle root
# is always carried by a "root=" / "root = " field (the tx hash uses "hash="), so we
# prefer those and take the LAST one (the final "file uploaded, root = 0x..." summary).
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_ROOT_NEAR_KEY = re.compile(r"root\s*[=:]\s*(0x[0-9a-fA-F]{64})", re.IGNORECASE)
_ANY_ROOT = re.compile(r"0x[0-9a-fA-F]{64}")

_UPLOAD_RETRIES = 3


def fetch_video(root_hash: str, storage_node_url: str) -> str:
    """
    Return the 0G Storage gateway download URL for the video. ffmpeg streams directly
    from this URL via HTTP Range requests — the full video is never buffered to disk.

    The indexer-turbo gateway serves files at /file?root=<root> (verified to return
    206 Partial Content with Accept-Ranges: bytes). NOTE: /download/<root> returns 404.
    """
    return f"{storage_node_url}/file?root={root_hash}"


def download_video(root_hash: str, storage_node_url: str, dest_dir: str = "/tmp") -> str:
    """
    Download the full video to local disk and return the path.

    Required because librosa/audioread CANNOT read an HTTP URL — it falls back to
    open(path) and raises FileNotFoundError on a URL. So audio analysis needs a local
    file. ffmpeg splice then input-seeks this local copy (still fast, no re-encode).
    Streamed to disk so we never hold the whole file in memory.
    """
    Path(dest_dir).mkdir(parents=True, exist_ok=True)
    dest = f"{dest_dir}/source_{root_hash[:12]}.mp4"
    url = fetch_video(root_hash, storage_node_url)
    with httpx.stream("GET", url, timeout=120.0, follow_redirects=True) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_bytes(256 * 1024):
                f.write(chunk)
    size = Path(dest).stat().st_size
    logger.info("Downloaded %s → %s (%d bytes)", root_hash, dest, size)
    return dest


def upload_clips(clip_results: List["ClipResult"], storage_node_url: str) -> List[str]:
    """
    Upload each finished clip via the Go CLI. Returns root-hash CIDs in clip_results order.
    Deletes each local /tmp file after a successful upload. Raises on unrecoverable failure.
    """
    cids: List[str] = []
    for clip in clip_results:
        cid = _upload_one(clip.local_path, storage_node_url)
        cids.append(cid)
        Path(clip.local_path).unlink(missing_ok=True)
    return cids


def _cli_base() -> list[str]:
    rpc = os.environ["ZG_RPC_URL"]
    key = os.environ["ZG_PRIVATE_KEY"]
    if not key:
        raise RuntimeError("ZG_PRIVATE_KEY is empty — cannot pay storage fees")
    binary = os.environ.get("ZG_STORAGE_CLI", "0g-storage-client")
    extra = os.environ.get("ZG_STORAGE_CLI_EXTRA", "").split()
    return [binary, "upload", "--url", rpc, "--key", key, *extra]


def _upload_one(local_path: str, indexer_url: str) -> str:
    """Run the CLI with retries (dropped uploads are common on testnet) and parse the root."""
    cmd = [*_cli_base(), "--indexer", indexer_url, "--file", local_path]
    last_err = ""
    for attempt in range(1, _UPLOAD_RETRIES + 1):
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        combined = f"{proc.stdout}\n{proc.stderr}"
        root = _parse_root(combined)
        if proc.returncode == 0 and root:
            logger.info("Uploaded %s → %s (attempt %d)", local_path, root, attempt)
            return root
        last_err = (proc.stderr or proc.stdout or "").strip()[-500:]
        logger.warning(
            "Upload attempt %d/%d for %s failed (rc=%s): %s",
            attempt, _UPLOAD_RETRIES, local_path, proc.returncode, last_err,
        )
        time.sleep(2 * attempt)
    raise RuntimeError(f"0g-storage-client upload failed for {local_path}: {last_err}")


def _parse_root(output: str) -> str:
    """Prefer the last CLI-labelled `root=` field; fall back to the first 64-hex hash."""
    clean = _ANSI.sub("", output)
    labelled = _ROOT_NEAR_KEY.findall(clean)
    if labelled:
        return labelled[-1]
    m = _ANY_ROOT.search(clean)
    return m.group(0) if m else ""
