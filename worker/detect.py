"""
Audio RMS event detector and window merger for ZeroFrame worker.
Day 3: audio spike detection only. Day 4 adds vision detection.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from typing import Generator, List, Tuple

import cv2
import librosa
import numpy as np
from ultralytics import YOLO

MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", "/app/models/yolov8n.pt")

# Audio anchor threshold vs the GLOBAL median energy. Env-overridable for on-site tuning
# without a rebuild. 1.8x cleanly isolated the goal/celebration on real footage; lower it
# (~1.5) to also catch build-up, raise it to be stricter.
AUDIO_SPIKE_RATIO = float(os.environ.get("ZF_AUDIO_SPIKE_RATIO", "1.8"))

_model: YOLO | None = None


def _get_model() -> YOLO:
    global _model
    if _model is None:
        _model = YOLO(MODEL_PATH)
    return _model


@dataclass
class EventWindow:
    start_ts: float
    end_ts: float
    trigger: str       # "audio" | "vision" | "combined"
    confidence: float  # 0.0 – 1.0


def detect_audio_spikes(video_path: str) -> List[EventWindow]:
    y, sr = librosa.load(video_path, sr=22050, mono=True)
    hop_length = sr   # 1-second frames
    rms = librosa.feature.rms(y=y, frame_length=sr, hop_length=hop_length)[0]
    n_frames = len(rms)

    # GLOBAL median baseline = the match's typical crowd-drone level. We deliberately do NOT
    # use a trailing/rolling baseline: verified on real footage, a rolling median ADAPTS to a
    # sustained goal roar and suppresses the very spike we want (the loudest second scored
    # only 1.68x its trailing baseline and was missed), and it is degenerate at clip start
    # (manufactured cold-start false positives). The global median is robust to both.
    baseline = max(float(np.median(rms)), 1e-6)

    raw_windows: List[EventWindow] = []
    for i in range(n_frames):
        ratio = float(rms[i] / baseline)
        if ratio <= AUDIO_SPIKE_RATIO:
            continue
        ts = i * hop_length / sr
        # Confidence 0–1 calibrated for global-baseline ratios: ~drone (1.0x) → 0,
        # a strong sustained roar (>=2.0x global median) → 1.
        confidence = min(max(ratio - 1.0, 0.0), 1.0)
        raw_windows.append(
            EventWindow(start_ts=max(0.0, ts - 4.0), end_ts=ts + 4.0,
                        trigger="audio", confidence=confidence)
        )

    merged = merge_windows(raw_windows)
    # Filter: must be between 5 and 90 seconds long
    return [w for w in merged if 5.0 <= (w.end_ts - w.start_ts) <= 90.0]


# Anchor-gated vision tuning.
VISION_PAD = 5.0   # seconds scanned on each side of an audio window (to catch nearby cuts)
BALL_CONF = 0.5    # YOLOv8 sports-ball confidence threshold
CUT_CORR = 0.4     # histogram-correlation below this = a broadcast camera cut


def sample_frames_range(
    video_path: str, start_ts: float, end_ts: float, fps: float = 2.0
) -> Generator[Tuple[float, np.ndarray], None, None]:
    """
    Sample frames ONLY within [start_ts, end_ts]. This is what keeps the pipeline fast:
    YOLO never scans the whole match, only the neighbourhood of an audio anchor.
    """
    cap = cv2.VideoCapture(video_path)
    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if native_fps <= 0:
        cap.release()
        return
    interval_ms = 1000.0 / fps
    current_ms = max(0.0, start_ts) * 1000.0
    end_ms = end_ts * 1000.0
    while current_ms <= end_ms:
        cap.set(cv2.CAP_PROP_POS_MSEC, current_ms)
        ret, frame = cap.read()
        if not ret:
            break
        yield current_ms / 1000.0, frame
        current_ms += interval_ms
    cap.release()


def refine_window(video_path: str, window: EventWindow) -> EventWindow:
    """
    Anchor-gated vision pass for ONE audio window. Scanning only ±VISION_PAD around it:
      A. YOLO (sports ball only) confirms it's gameplay → trigger upgraded to "combined".
      B. Histogram cuts EXTEND the clip outward to clean broadcast shot boundaries.
    Falls back to the padded audio window when no cut/ball is found.

    ⚠️ TECH DEBT (must fix before Round 2): on REAL broadcast footage the ball is too
    small/blurry to clear BALL_CONF=0.5 in the goal zone, so sub-detector A almost never
    fires — trigger stays "audio" and YOLO contributes ZERO to the output while burning CPU.
    Detection is currently audio-only in practice. This is NOT a robust multimodal engine.
    Round 2: ball-tracking model tuned for broadcast / motion blur, or drop YOLO for a
    cheaper visual-motion signal. Kept here to show intent, not because it works.
    """
    model = _get_model()
    scan_start = max(0.0, window.start_ts - VISION_PAD)
    scan_end = window.end_ts + VISION_PAD

    ball_seen = False
    cut_ts: List[float] = []
    prev_hist: np.ndarray | None = None

    for ts, frame in sample_frames_range(video_path, scan_start, scan_end, fps=2.0):
        h = frame.shape[0]

        # A. Ball-in-goal-zone (bottom third). Class 32 ONLY — we deliberately do NOT track
        # persons (class 0); 22 players per frame chokes CPU inference for zero MVP benefit.
        results = model(frame, verbose=False, classes=[32])
        for result in results:
            for box in result.boxes:
                if int(box.cls[0]) == 32 and float(box.conf[0]) > BALL_CONF:
                    _, y1, _, y2 = box.xyxy[0].tolist()
                    if (y1 + y2) / 2.0 > h * 0.67:
                        ball_seen = True

        # B. Camera cut
        hist = cv2.calcHist([frame], [0, 1, 2], None, [32, 32, 32], [0, 256] * 3)
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            if cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL) < CUT_CORR:
                cut_ts.append(ts)
        prev_hist = hist

    # Snap to camera cuts OUTWARD ONLY — never inward. Broadcast footage cuts every few
    # seconds; snapping to the nearest cut inside the window collapses the clip below the 5s
    # minimum (verified: a real goal window shrank 8s→2.5s). So we only extend the clip to a
    # cut just before the window start / just after the window end, else keep the audio window.
    cuts_before = [c for c in cut_ts if c <= window.start_ts]
    cuts_after = [c for c in cut_ts if c >= window.end_ts]
    start_ts = max(cuts_before) if cuts_before else window.start_ts
    end_ts = min(cuts_after) if cuts_after else window.end_ts

    return EventWindow(
        start_ts=start_ts,
        end_ts=end_ts,
        trigger="combined" if ball_seen else "audio",
        confidence=min(1.0, window.confidence * 1.2) if ball_seen else window.confidence,
    )


def merge_windows(windows: List[EventWindow]) -> List[EventWindow]:
    if not windows:
        return []

    sorted_wins = sorted(windows, key=lambda w: w.start_ts)
    merged: List[EventWindow] = []
    current = sorted_wins[0]

    for nxt in sorted_wins[1:]:
        gap = nxt.start_ts - current.end_ts
        if gap < 3.0:
            current = EventWindow(
                start_ts=current.start_ts,
                end_ts=max(current.end_ts, nxt.end_ts),
                trigger=current.trigger,
                confidence=max(current.confidence, nxt.confidence),
            )
        else:
            merged.append(current)
            current = nxt

    merged.append(current)
    return merged


def detect_events(video_path: str) -> List[EventWindow]:
    """
    Audio-anchored detection. RMS spikes are the anchors; YOLO ball-confirmation and
    histogram-cut boundaries run ONLY near each anchor (see refine_window). There is no
    full-video vision scan — that is what keeps a full match fast. A purely visual event
    with no audio spike is intentionally NOT detected at the group-stage MVP.
    """
    anchors = detect_audio_spikes(video_path)
    refined = [refine_window(video_path, w) for w in anchors]
    merged = merge_windows(refined)
    return [w for w in merged if 5.0 <= (w.end_ts - w.start_ts) <= 90.0]


if __name__ == "__main__":
    windows = detect_events(sys.argv[1])
    print(json.dumps([asdict(w) for w in windows], indent=2))
