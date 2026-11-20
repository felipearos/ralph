#!/usr/bin/env python3
"""Shared, line-atomic storage for one Ralph iteration's event timeline."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def received_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def iteration_number(value: str | None) -> int | str | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return value


class TimelineWriter:
    """Append complete JSON lines while other renderers write the same file."""

    def __init__(
        self,
        path: Path,
        stage: str,
        iteration: int | str | None,
        run: str | None = None,
    ) -> None:
        self.path = path
        self.stage = stage
        self.iteration = iteration
        self.run = run
        path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, event: dict[str, Any], received_at: str | None = None) -> dict[str, Any]:
        stamped = dict(event)
        stamped["ralph_stage"] = self.stage
        stamped["ralph_received_at"] = received_at or received_now()
        if self.iteration is not None:
            stamped["ralph_iteration"] = self.iteration
        if self.run:
            stamped["ralph_run"] = self.run
        line = (json.dumps(stamped, ensure_ascii=False, separators=(",", ":")) + "\n").encode()

        fd = os.open(self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            written = 0
            while written < len(line):
                count = os.write(fd, line[written:])
                if count <= 0:
                    raise OSError("timeline append made no progress")
                written += count
        finally:
            os.close(fd)
        return stamped


def stage_event() -> None:
    """Append one stage boundary."""

    parser = argparse.ArgumentParser(description="Append a Ralph stage lifecycle event")
    parser.add_argument("state", choices=("started", "completed", "failed", "degraded"))
    parser.add_argument("--stage", required=True)
    parser.add_argument("--invocation", required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    path = os.environ.get("RALPH_TIMELINE", "").strip()
    if not path:
        return
    writer = TimelineWriter(
        Path(path),
        args.stage,
        iteration_number(os.environ.get("RALPH_ITERATION")),
        os.environ.get("RALPH_RUN_ID"),
    )
    writer.append(
        {
            "type": "ralph_stage",
            "state": args.state,
            "invocation": args.invocation,
            "runner": args.runner,
            "model": args.model,
        }
    )


if __name__ == "__main__":
    stage_event()
