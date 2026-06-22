"""
0G Storage SDK wrapper — stub for Day 2.
Full implementation lives in the worker container (worker/worker.py).
The backend never handles binary data; this file is reserved for
any metadata queries the backend might need in future days.
"""
import logging

from config import settings

logger = logging.getLogger(__name__)


async def get_file_metadata(storage_cid: str) -> dict:
    """
    Stub: return basic metadata for a CID already on 0G Storage.
    Not called during Day 2 — wired up in Day 5 if needed.
    """
    return {"cid": storage_cid, "node": settings.zg_storage_node_url}
