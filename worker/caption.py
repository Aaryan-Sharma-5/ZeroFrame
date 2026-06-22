"""
0G Compute caption generation — the project's genuine 0G Compute touchpoint.

For each highlight clip we send its *event metadata* (timestamp window, detection
trigger, confidence) to a DeepSeek chat model on the 0G Compute Router (OpenAI-compatible
API) and get back a terse, broadcast-style caption.

IMPORTANT — honest framing:
  * DeepSeek is a TEXT model. It does NOT see the video. The caption is grounded in the
    detector's event signals, not pixels. Don't let the UI imply visual comprehension.
  * The verifiable artifact is the response `id` (chatcmpl-...), surfaced as
    "0G Compute response ID". Full on-chain TEE settlement is broker-SDK/TypeScript only
    and out of scope for this Python worker.
  * Captioning is best-effort: a Router failure must NOT fail the clip. We fall back to a
    deterministic caption and an empty response id so the pipeline always completes.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_ROUTER_URL = os.environ.get("ZG_COMPUTE_ROUTER_URL", "https://router-api.0g.ai/v1")
_API_KEY = os.environ.get("ZG_COMPUTE_API_KEY", "")
# minimax-m3 is the only FREE model on the Router (prompt/completion price 0) — critical
# because our wallet is testnet-funded and paid models settle on mainnet. It is also
# TEE-attested (TeeTLS/TDX), so verify_tee gives a real cryptographic compute proof.
# NOTE: it has thinking ON by default — we disable it per-request (see generate_caption).
_MODEL = os.environ.get("ZG_COMPUTE_MODEL", "minimax-m3")

# Map the detector's trigger to a human descriptor for the prompt. These mirror what each
# trigger actually means in detect.py (audio RMS spike / vision goalmouth+cut / both).
_TRIGGER_DESC = {
    "audio": "crowd-roar audio spike (no clear visual)",
    "vision": "goalmouth action / camera cut detected on frame",
    "combined": "crowd roar AND visual goalmouth action",
}

# Persona + format lock. The few-shot turns are what kill the generic
# "This clip shows a soccer match where..." default and pin the broadcast register —
# including the audio-only exemplar that teaches it to stay confident without visuals.
_SYSTEM = (
    "You are a veteran football (soccer) highlight editor writing the on-screen caption "
    "for a single clip. Output ONE line, 4-10 words, present tense, broadcast energy. "
    "No hashtags, no emojis, no quotes, no preamble, no explanation. Never write "
    '"the video shows", "this clip", or mention data/metadata/confidence. If signals are '
    "thin, stay punchy and evocative — never apologize, never hedge."
)
_FEWSHOT = [
    {
        "role": "user",
        "content": (
            "Timestamp 87:12-87:42 | trigger: crowd roar AND visual goalmouth action "
            "| intensity 0.94"
        ),
    },
    {"role": "assistant", "content": "GOAL! The roof comes off the stadium"},
    {
        "role": "user",
        "content": "Timestamp 12:03-12:21 | trigger: crowd-roar audio spike (no clear visual) | intensity 0.71",
    },
    {"role": "assistant", "content": "The crowd senses it — danger building"},
]

_client = None


def _get_client():
    """Lazily build the OpenAI client pointed at the 0G Router. None if unconfigured."""
    global _client
    if not _API_KEY:
        return None
    if _client is None:
        from openai import OpenAI  # imported lazily so --test mode needs no openai install
        # Bounded timeout + retries: the OpenAI SDK defaults to a 600s timeout, which would
        # let a hung 0G Router stall the whole job. 15s/1 retry keeps the pipeline snappy;
        # on timeout the caller catches the exception and uses the deterministic fallback.
        _client = OpenAI(
            base_url=_ROUTER_URL, api_key=_API_KEY, timeout=15.0, max_retries=1
        )
    return _client


def _mmss(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    return f"{s // 60:02d}:{s % 60:02d}"


def _fallback(trigger: str) -> str:
    """Deterministic caption when the Router is unreachable/unconfigured."""
    return {
        "audio": "The crowd erupts - something big!",
        "vision": "Action explodes in the final third",
        "combined": "GOAL! The stadium goes wild",
    }.get(trigger, "Highlight moment")


def _compute_proof(resp) -> str:
    """
    The verifiable 0G Compute artifact stored as the clip's compute_id: the response id,
    suffixed with the TEE attestation flag when the Router confirms it. The flag lives at
    response.x_0g_trace.tee_verified (verified against a real minimax-m3 response).
    """
    proof = getattr(resp, "id", "") or ""
    try:
        extra = getattr(resp, "model_extra", None) or {}
        trace = extra.get("x_0g_trace") or {}
        if isinstance(trace, dict) and trace.get("tee_verified"):
            proof = f"{proof}|tee_verified=true"
    except Exception:
        pass
    return proof


def generate_caption(
    start_ts: float, end_ts: float, trigger: str, confidence: float
) -> tuple[str, str]:
    """
    Returns (caption, compute_response_id). compute_response_id is "" on fallback.
    Never raises — captioning is best-effort and must not fail the clip.
    """
    client = _get_client()
    if client is None:
        logger.info("ZG_COMPUTE_API_KEY unset — using fallback caption for trigger=%s", trigger)
        return _fallback(trigger), ""

    intensity = round(min(1.0, max(0.0, confidence)), 2)
    live_turn = (
        f"Timestamp {_mmss(start_ts)}-{_mmss(end_ts)} | "
        f"trigger: {_TRIGGER_DESC.get(trigger, trigger)} | intensity {intensity}"
    )
    try:
        resp = client.chat.completions.create(
            model=_MODEL,
            messages=[{"role": "system", "content": _SYSTEM}, *_FEWSHOT,
                      {"role": "user", "content": live_turn}],
            temperature=0.8,
            max_tokens=48,
            stop=["\n"],
            # minimax-m3 thinks by default — disable it so we get a terse caption, not a
            # <think>…</think> dump. The Router wants a ThinkingConfig object (NOT a bool):
            # {"type": "disabled"} is verified-correct. verify_tee requests the on-chain TEE
            # attestation that lands in response.x_0g_trace.tee_verified (our compute proof).
            extra_body={"thinking": {"type": "disabled"}, "verify_tee": True},
        )
        caption = (resp.choices[0].message.content or "").strip().strip('"').strip()
        if not caption:
            return _fallback(trigger), ""
        return caption, _compute_proof(resp)
    except Exception as exc:  # network, auth, rate-limit, billing — degrade gracefully
        logger.warning("0G Compute caption failed (trigger=%s): %s", trigger, exc)
        return _fallback(trigger), ""
