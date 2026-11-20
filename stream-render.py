#!/usr/bin/env python3
"""Render Claude Code stream-json without ever writing its raw bytes.

stdin is Claude's JSONL stream. stdout is the live, human timeline. The three
files are intentionally separate: redacted structured events for forensics,
the final assistant message for loop control, and live runner signals for the
existing failure record.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Callable

from timeline import TimelineWriter, iteration_number, received_now


CONFIG_PATH = Path(__file__).resolve().parent / "runner-signals.json"
DEFAULT_EVIDENCE_MAX_CHARS = 300


def load_config() -> dict[str, Any]:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        print(f"stream-render: no {CONFIG_PATH.name} ({error}); discarding the stream", file=sys.stderr)
        return {}
    if config.get("version") != 1:
        print(f"stream-render: unsupported {CONFIG_PATH.name}; discarding the stream", file=sys.stderr)
        return {}
    return config


def _any_of(patterns: list[str]) -> re.Pattern[str] | None:
    if not patterns:
        return None
    try:
        return re.compile("|".join(patterns), re.IGNORECASE)
    except re.error:
        return None


def build_redactor(config: dict[str, Any], env: dict[str, str]) -> Callable[[str], str]:
    """Mirror runner-failure.ts and delegate-render.py: values, then shapes."""
    rules = config.get("secretEnvNames") or {}
    match = _any_of(rules.get("match") or [])
    never = _any_of((rules.get("never") or {}).get("match") or [])
    except_ = _any_of((rules.get("never") or {}).get("except") or [])
    minimum = int(rules.get("minimumValueLength") or 8)

    values: list[tuple[str, str]] = []
    for name, value in env.items():
        if len(value) < minimum or not (match and match.search(name)):
            continue
        if never and never.search(name) and not (except_ and except_.search(name)):
            continue
        values.append((value, f"env:{name}"))
        escaped = json.dumps(value)[1:-1]
        if escaped != value:
            values.append((escaped, f"env:{name}"))
        for line in value.splitlines() if "\n" in value else []:
            if len(line.strip()) >= minimum:
                values.append((line.strip(), f"env:{name}"))
    values.sort(key=lambda pair: len(pair[0]), reverse=True)
    compiled_values = [(re.compile(re.escape(value)), label) for value, label in values]

    shapes: list[tuple[re.Pattern[str], str]] = []
    for entry in (config.get("secretPatterns") or {}).get("patterns") or []:
        try:
            shapes.append((re.compile(entry["pattern"], re.IGNORECASE), entry["label"]))
        except (KeyError, re.error) as error:
            print(f"stream-render: skipping bad secret pattern ({error})", file=sys.stderr)

    def redact(text: str) -> str:
        for pattern, label in compiled_values:
            text = pattern.sub(lambda _match, label=label: f"[redacted:{label}]", text)
        for pattern, label in shapes:
            text = pattern.sub(lambda _match, label=label: f"[redacted:{label}]", text)
        return text

    return redact


def compact(value: Any) -> str:
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, list):
        parts = [compact(item.get("text", item)) if isinstance(item, dict) else compact(item) for item in value]
        return " ".join(part for part in parts if part)
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def bounded(text: str, maximum: int = 300) -> str:
    text = compact(text)
    return text if len(text) <= maximum else text[: maximum - 1] + "…"


def tool_target(name: str, tool_input: Any) -> str:
    if not isinstance(tool_input, dict):
        return compact(tool_input)
    keys = {
        "Bash": ("command",),
        "Read": ("file_path", "path"),
        "Write": ("file_path", "path"),
        "Edit": ("file_path", "path"),
        "Glob": ("pattern", "path"),
        "Grep": ("pattern", "path"),
        "Agent": ("description", "prompt", "subagent_type"),
        "Skill": ("skill",),
    }.get(name, ("file_path", "path", "command", "query", "url", "prompt"))
    for key in keys:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return bounded(value, 240)
    return bounded(tool_input, 240)


class Renderer:
    def __init__(
        self,
        events: Path,
        final: Path,
        signals: Path,
        redact: Callable[[str], str],
        evidence_max: int,
    ) -> None:
        self.events = events
        self.final = final
        self.signals = signals
        self.redact = redact
        self.evidence_max = evidence_max
        self.tools: dict[str, str] = {}
        for path in (final, signals):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf8")
        # The events file is the ITERATION's, not this session's: a sigil
        # recovery turn, a session resumed after the supervisor waited on a PR,
        # and a budget handoff all append to it. Truncating here erased the
        # first session's record — and the token cap that counts from it.
        events.parent.mkdir(parents=True, exist_ok=True)
        events.touch()
        self.timeline = TimelineWriter(
            events,
            "orchestrator",
            iteration_number(os.environ.get("RALPH_ITERATION")),
            os.environ.get("RALPH_RUN_ID"),
        )

    def say(self, at: str, label: str, text: str) -> None:
        redacted_text = bounded(self.redact(text), 2_000)
        print(f"[{at}] {label}: {redacted_text}".rstrip(), flush=True)

    def signal(self, kind: str, evidence: str, at: str) -> None:
        # Always `runner`: both callers read Claude's own events (a rejected
        # rate-limit event, the harness's `permission_denials` list), never a
        # tool result's text. See the channel note in delegate-render.py.
        redacted_evidence = bounded(self.redact(evidence), self.evidence_max)
        with self.signals.open("a", encoding="utf8") as handle:
            handle.write(
                json.dumps({"at": at, "kind": kind, "evidence": redacted_evidence, "source": "runner"})
                + "\n"
            )
            handle.flush()

    def persist(self, event: dict[str, Any], received_at: str) -> dict[str, Any]:
        # Redact the serialized form so JSON escaping cannot route around exact
        # environment-value matches, then parse it back to keep real JSONL.
        serialized = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        redacted_event = json.loads(self.redact(serialized))
        if event.get("runner") == "codex":
            session = os.environ.get("RALPH_SESSION_ID", "")
            if session and all(c in "0123456789abcdefABCDEF-" for c in session):
                path = Path(os.environ.get("RALPH_LOG_DIR", ".ralph/logs")) / f"codex-orchestrator-{session}.jsonl"
                with path.open("a", encoding="utf8") as handle:
                    handle.write(json.dumps(redacted_event) + "\n")
        return self.timeline.append(redacted_event, received_at)

    def render(self, event: dict[str, Any], received_at: str) -> None:
        redacted_event = self.persist(event, received_at)
        at = (
            redacted_event.get("timestamp")
            if isinstance(redacted_event.get("timestamp"), str)
            else received_at
        )
        kind = redacted_event.get("type")

        if kind == "assistant":
            message = (
                redacted_event.get("message")
                if isinstance(redacted_event.get("message"), dict)
                else {}
            )
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                if block_type == "thinking":
                    self.say(at, "thinking", block.get("thinking", ""))
                elif block_type == "text":
                    self.say(at, "text", block.get("text", ""))
                elif block_type == "tool_use":
                    name = str(block.get("name") or "unknown")
                    use_id = block.get("id")
                    if isinstance(use_id, str):
                        self.tools[use_id] = name
                    self.say(at, "tool", f"{name} — {tool_target(name, block.get('input'))}")
            return

        if kind == "user":
            message = (
                redacted_event.get("message")
                if isinstance(redacted_event.get("message"), dict)
                else {}
            )
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                use_id = block.get("tool_use_id")
                name = self.tools.get(use_id, "unknown") if isinstance(use_id, str) else "unknown"
                outcome = "error" if block.get("is_error") else "ok"
                self.say(at, "tool result", f"{name} — {outcome} — {compact(block.get('content'))}")
            return

        if kind == "rate_limit_event":
            info = (
                redacted_event.get("rate_limit_info")
                if isinstance(redacted_event.get("rate_limit_info"), dict)
                else {}
            )
            status = str(info.get("status") or "unknown")
            limit_type = str(info.get("rateLimitType") or "unknown")
            evidence = f"rate limit {status}: {limit_type}"
            self.say(at, "rate limit", f"{status} — {limit_type}")
            if (
                status == "rejected"
                and info.get("isUsingOverage") is not True
                and info.get("overageInUse") is not True
            ):
                self.signal("usage-limit", evidence, at)
            return

        if kind == "result":
            usage = (
                redacted_event.get("usage")
                if isinstance(redacted_event.get("usage"), dict)
                else {}
            )
            details = usage.get("output_tokens_details") if isinstance(usage.get("output_tokens_details"), dict) else {}
            self.say(
                at,
                "usage",
                f"input {usage.get('input_tokens', 0)}, output {usage.get('output_tokens', 0)}, "
                f"cache write {usage.get('cache_creation_input_tokens', 0)}, "
                f"cache read {usage.get('cache_read_input_tokens', 0)}, "
                f"thinking {details.get('thinking_tokens', 0)}",
            )
            final = redacted_event.get("result")
            if isinstance(final, str):
                self.final.write_text(final.rstrip("\n") + "\n", encoding="utf8")
            denials = redacted_event.get("permission_denials") or []
            for denial in denials if isinstance(denials, list) else []:
                if not isinstance(denial, dict):
                    continue
                name = str(denial.get("tool_name") or denial.get("name") or "unknown")
                evidence = f"permission denied: {name} — {tool_target(name, denial.get('tool_input'))}"
                self.say(at, "permission denial", evidence)
                self.signal("permission-denied", evidence, at)
            return

        if kind == "system":
            self.say(at, "system", str(redacted_event.get("subtype") or "event"))
            return
        self.say(at, "event", str(kind or "unknown"))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--final", type=Path, required=True)
    parser.add_argument("--signals", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    config = load_config()
    patterns = (config.get("secretPatterns") or {}).get("patterns") or []
    env_names = (config.get("secretEnvNames") or {}).get("match") or []
    if not patterns or not env_names:
        for _line in sys.stdin:
            pass
        return 1
    redact = build_redactor(config, os.environ)
    renderer = Renderer(
        args.events,
        args.final,
        args.signals,
        redact,
        int(config.get("evidenceMaxChars") or DEFAULT_EVIDENCE_MAX_CHARS),
    )
    for raw in sys.stdin:
        received_at = received_now()
        try:
            event = json.loads(raw)
        except ValueError:
            # Persist malformed input structurally and redacted; never echo the
            # raw line into an error diagnostic where it could carry a secret.
            renderer.persist({"type": "invalid", "raw": redact(raw.rstrip("\n"))}, received_at)
            renderer.say(received_at, "event", "invalid JSON")
            continue
        if isinstance(event, dict):
            renderer.render(event, received_at)
        else:
            renderer.persist({"type": "invalid", "value": event}, received_at)
            renderer.say(received_at, "event", "non-object JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
