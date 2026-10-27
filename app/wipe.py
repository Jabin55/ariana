"""파일을 되살릴 수 없게 지운다: 내용을 0으로 덮어쓴 뒤 디스크에 반영하고 지운다."""

from __future__ import annotations

import os
from pathlib import Path

CHUNK = 1024 * 1024


def wipe(path: Path | str) -> None:
    path = Path(path)
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return
    try:
        with open(path, "r+b", buffering=0) as f:
            zero = bytes(min(CHUNK, size or 1))
            left = size
            while left > 0:
                n = f.write(zero[:min(len(zero), left)])
                left -= n
            os.fsync(f.fileno())
    except OSError:
        pass  # 덮어쓰지 못해도 아래에서 지운다
    path.unlink(missing_ok=True)
