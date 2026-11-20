#!/usr/bin/env python3
"""Run one command with a TTY on its output and relay bytes as they arrive."""

from __future__ import annotations

import errno
import os
import pty
import subprocess
import sys
import termios


def main(argv: list[str]) -> int:
    if not argv:
        print("pty-run: expected a command", file=sys.stderr)
        return 3

    master, slave = pty.openpty()
    attributes = termios.tcgetattr(slave)
    attributes[1] &= ~termios.OPOST
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    child = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    status: int | None = None
    relay_failed = False
    try:
        while True:
            try:
                chunk = os.read(master, 64 * 1024)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            written = 0
            while written < len(chunk):
                try:
                    written += os.write(sys.stdout.fileno(), chunk[written:])
                except BrokenPipeError:
                    relay_failed = True
                    return 141
    except BaseException:
        relay_failed = True
        raise
    finally:
        os.close(master)
        if relay_failed and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        status = child.returncode

    if status is None:
        status = child.wait()
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
