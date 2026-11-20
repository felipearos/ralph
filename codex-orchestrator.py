#!/usr/bin/env python3
"""Run Codex and translate its events into Ralph's shared orchestration stream.

Ralph owns a stable session UUID; Codex owns its thread UUID. Keep the mapping
explicit so recovery never resumes another loop's most recent conversation.
Native token_count records provide live usage between exec's turn.completed
summaries, allowing the existing supervisor budget guard to stop a long turn.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import uuid


class Adapter:
    def __init__(self, session: str, model: str, state_path: Path):
        self.session = session
        self.model = "codex/" + model
        self.state_path = state_path
        self.thread = ""
        self.total = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
        self.final = ""
        self.failed = False
        self.rollout: Path | None = None
        self.offset = 0
        self.partial = ""
        if state_path.exists():
            state = json.loads(state_path.read_text())
            self.thread = str(uuid.UUID(state["thread"]))
            self.total.update(state.get("total", {}))
        self.turn_start = dict(self.total)

    def emit(self, event: dict):
        event.update(session_id=self.session, runner="codex")
        print(json.dumps(event, separators=(",", ":")), flush=True)

    def save(self):
        if self.thread:
            temporary = self.state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"thread": self.thread, "total": self.total}))
            temporary.replace(self.state_path)

    def usage(self, total: dict):
        current = {key: max(self.total[key], int(total.get(key) or 0)) for key in self.total}
        delta = {key: current[key] - self.total[key] for key in current}
        if not any(delta.values()):
            return
        self.total = current
        self.save()
        self.emit({"type": "assistant", "message": {
            "id": f"codex-{self.thread}-{sum(current.values())}", "model": self.model,
            "content": [], "usage": {
                "input_tokens": max(0, delta["input_tokens"] - delta["cached_input_tokens"]),
                "cache_read_input_tokens": delta["cached_input_tokens"],
                "output_tokens": delta["output_tokens"],
            }}})

    def poll_usage(self, home: Path):
        if not self.thread:
            return
        if self.rollout is None:
            self.rollout = next((home / "sessions").glob(f"**/*{self.thread}.jsonl"), None)
        if self.rollout is None:
            return
        with self.rollout.open() as handle:
            handle.seek(self.offset)
            chunk = handle.read()
            self.offset = handle.tell()
        lines = (self.partial + chunk).split("\n")
        self.partial = lines.pop()
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload") or {}
            if record.get("type") == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                if isinstance(info.get("total_token_usage"), dict):
                    self.usage(info["total_token_usage"])

    def event(self, event: dict):
        kind = event.get("type")
        if kind == "thread.started":
            self.thread = str(uuid.UUID(event["thread_id"]))
            self.save()
            self.emit({"type": "system", "subtype": "init", "model": self.model,
                       "codex_thread_id": self.thread})
        elif kind == "item.completed":
            item = event.get("item") or {}
            item_type = item.get("type")
            if item_type == "agent_message":
                self.final = item.get("text") or ""
                self.emit({"type": "assistant", "message": {"content": [{"type": "text", "text": self.final}]}})
            elif item_type == "command_execution":
                identity = item.get("id") or str(uuid.uuid4())
                self.emit({"type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": identity, "name": "Bash",
                    "input": {"command": item.get("command") or ""}}]}})
                self.emit({"type": "user", "message": {"content": [{
                    "type": "tool_result", "tool_use_id": identity,
                    "is_error": item.get("exit_code", 0) != 0,
                    "content": item.get("aggregated_output") or ""}]}})
            else:
                self.emit({"type": "codex_item", "item": item})
        elif kind == "turn.completed":
            usage = event.get("usage") or {}
            self.usage({key: self.turn_start[key] + int(usage.get(key) or 0) for key in self.total})
            self.emit({"type": "result", "subtype": "success", "result": self.final,
                       "usage": {"input_tokens": self.total["input_tokens"] - self.total["cached_input_tokens"],
                                 "cache_read_input_tokens": self.total["cached_input_tokens"],
                                 "output_tokens": self.total["output_tokens"]}})
        elif kind == "turn.failed":
            self.failed = True
            self.emit({"type": "result", "subtype": "error", "is_error": True,
                       "result": "", "error": event.get("error")})
            print(json.dumps(event), file=sys.stderr, flush=True)
        else:
            self.emit(event)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort")
    args = parser.parse_args()
    # Validate before constructing any filesystem path or process selector.
    session = str(uuid.UUID(args.session_id))
    logdir = Path(os.environ.get("RALPH_LOG_DIR", ".ralph/logs"))
    logdir.mkdir(parents=True, exist_ok=True)
    state_path = logdir / f"codex-thread-{session}.json"
    if not args.resume:
        state_path.unlink(missing_ok=True)
    adapter = Adapter(session, args.model, state_path)
    if args.resume and not adapter.thread:
        print("codex: cannot recover without this Ralph session's thread id", file=sys.stderr)
        return 2
    command = ["codex", "exec"]
    if args.resume:
        command += ["resume"]
    # Orchestration owns git, GitHub, gates and journal publication, as the
    # existing Claude orchestrator does. Executors/inspectors have separate rails.
    command += ["--model", args.model, "--json", "--dangerously-bypass-approvals-and-sandbox",
                "-c", 'shell_environment_policy.inherit="all"',
                "-c", "shell_environment_policy.ignore_default_excludes=true"]
    if args.effort:
        command += ["-c", "model_reasoning_effort=" + json.dumps(args.effort)]
    if args.resume:
        command += [adapter.thread]
    command += ["-"]
    # Inherit the prompt pipe. It never appears in ps output (which can contain
    # project secrets), while --session-id remains available to the budget guard.
    child = subprocess.Popen(command, stdin=sys.stdin, stdout=subprocess.PIPE,
                             text=True, start_new_session=True)

    def stop(signum, _frame):
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    events: queue.Queue[str | None] = queue.Queue()

    def read():
        assert child.stdout is not None
        for line in child.stdout:
            events.put(line)
        events.put(None)

    threading.Thread(target=read, daemon=True).start()
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    try:
        while True:
            adapter.poll_usage(home)
            try:
                line = events.get(timeout=0.25)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                event = json.loads(line)
            except ValueError:
                print(line.rstrip(), file=sys.stderr, flush=True)
                continue
            if isinstance(event, dict):
                adapter.event(event)
        adapter.poll_usage(home)
        return child.wait() or (1 if adapter.failed else 0)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == "__main__":
    sys.exit(main())
