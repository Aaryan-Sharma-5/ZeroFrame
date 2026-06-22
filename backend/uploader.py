"""
0G Storage upload via the official Go `0g-storage-client` CLI (baked into the backend image).

Why server-side: the browser `@0glabs/0g-ts-sdk` upload reverts on the Galileo Flow
contract (gasUsed pinned at 80% of the limit, then CALL_EXCEPTION — likely a stale SDK
ABI), while the Go CLI uploads reliably at ~292k gas. So the browser POSTs the file here
and we shell out to the proven binary. This deliberately breaks the original "FastAPI never
touches video" rule — a documented, forced deviation (see docs/ARCHITECTURE.md).

This module imports NO ML/video libraries; it only writes a temp file and runs a subprocess.
"""
import logging
import os
import re
import subprocess

from config import settings

logger = logging.getLogger(__name__)

# The CLI emits ANSI-coloured logrus output; strip it before parsing. The merkle root is a
# "root=" field (tx hash uses "hash="), chunk count is "chunks=".
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_ROOT = re.compile(r"root\s*[=:]\s*(0x[0-9a-fA-F]{64})", re.IGNORECASE)
_ANY_HASH = re.compile(r"0x[0-9a-fA-F]{64}")
_TXHASH = re.compile(r"hash\s*[=:]\s*(0x[0-9a-fA-F]{64})", re.IGNORECASE)
_CHUNKS = re.compile(r"chunks\s*[=:]\s*(\d+)", re.IGNORECASE)


def upload_to_0g(local_path: str) -> dict:
    """
    Upload a local file to 0G Storage. Returns {root_hash, storage_cid, tx_hash, chunks}.
    Raises RuntimeError on failure (non-zero exit or no parseable root).
    """
    if not settings.zg_private_key:
        raise RuntimeError("ZG_PRIVATE_KEY is empty — cannot pay storage fees")

    binary = os.environ.get("ZG_STORAGE_CLI", "0g-storage-client")
    extra = os.environ.get("ZG_STORAGE_CLI_EXTRA", "").split()
    cmd = [
        binary, "upload",
        "--url", settings.zg_rpc_url,
        "--key", settings.zg_private_key,
        "--indexer", settings.zg_storage_node_url,
        *extra,
        "--file", local_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    out = _ANSI.sub("", f"{proc.stdout}\n{proc.stderr}")

    roots = _ROOT.findall(out)
    root = roots[-1] if roots else (m.group(0) if (m := _ANY_HASH.search(out)) else "")
    if proc.returncode != 0 or not root:
        tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"0g-storage-client upload failed (rc={proc.returncode}): {tail}")

    txs = _TXHASH.findall(out)
    chunks = _CHUNKS.search(out)
    logger.info("Uploaded %s → root=%s", local_path, root)
    return {
        "root_hash": root,
        "storage_cid": root,
        "tx_hash": txs[-1] if txs else "",
        "chunks": int(chunks.group(1)) if chunks else 0,
    }
