"""
ffmpeg clip splicing for ZeroFrame worker.
-ss MUST appear before -i (input seeking, not output seeking).
-t is used for duration, not -to, because -to is absolute file position.
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import List

from detect import EventWindow


@dataclass
class ClipResult:
    local_path: str
    start_ts: float
    end_ts: float
    duration: float
    trigger: str
    confidence: float


def splice_clips(
    source_url: str,
    windows: List[EventWindow],
    output_dir: str = "/tmp/clips",
) -> List[ClipResult]:
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    results = []
    for i, window in enumerate(windows):
        out_path = f"{output_dir}/clip_{i:03d}.mp4"
        _splice_one(source_url, window.start_ts, window.end_ts, out_path)
        results.append(
            ClipResult(
                local_path=out_path,
                start_ts=window.start_ts,
                end_ts=window.end_ts,
                duration=window.end_ts - window.start_ts,
                trigger=window.trigger,
                confidence=window.confidence,
            )
        )
    return results


def _splice_one(source_url: str, start_ts: float, end_ts: float, out_path: str) -> None:
    duration = end_ts - start_ts
    cmd = [
        "ffmpeg",
        "-ss", str(start_ts),            # INPUT SEEK — must be before -i
        "-i", source_url,                # 0G gateway URL; ffmpeg pulls only needed byte ranges
        "-t", str(duration),             # relative duration from seek point (not -to)
        "-c", "copy",                    # stream copy, no re-encode
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",       # moov atom at front for browser inline play
        "-y",                            # overwrite without prompt
        out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for clip {out_path}:\n{result.stderr}")
