#!/usr/bin/env python3
"""Render a harness's JSON event stream and total its token usage.

`ralph/delegate.sh` runs the executor with --format json for two reasons at
once: the events carry per-step token usage, which the pretty renderer drops,
and they can still be shown
to the orchestrator as readable text. This does both in one pass over stdin.

    opencode run --format json ... | delegate-render.py <usage-out> <model>
    codex exec --json ...         | delegate-render.py <usage-out> <model> codex
    claude -p --output-format stream-json --verbose ...
                                  | delegate-render.py <usage-out> <model> claude

`ralph/inspect.sh` runs the read-only stages on either harness, so the second
event shape lives here rather than in a second script: the usage file, the
accumulation rule and the cost booking are the same job either way, and two
copies of them would drift the way the model settings did before
`ralph/models.json` existed.

`usage-out` receives shell-sourceable KEY=VALUE totals. A run emits one usage
event per assistant step (opencode) or per turn (codex), so everything here
accumulates — reading only the last one silently undercounts a multi-step task.

It also receives `DELEGATE_TEXT`, which is 1 only when the LAST thing the
harness did was speak. That is not a statistic, and the "last" is the whole
point: this script prints tool hints and pass-through diagnostics onto the same
stream as the report, so a log with bytes in it is no evidence that a report
was written — and neither is prose anywhere in the run, because a harness that
says "I will start by reading the diff", reads it, and then dies has produced
an introduction and no report. So tool activity CLEARS the flag and prose sets
it, which makes it mean "the run ended with an assistant message".
`ralph/inspect.sh` publishes "the report is on stdout" as its contract, and
this is what lets it check the claim.

Two things it does besides render, both because this is the ONLY point every
byte a harness emits passes through on its way to a log an operator reads:

**It redacts.** The orchestrator runs under Doppler, and this process — unlike
the harness upstream of it in the pipeline, which `env -i` strips — inherits
that environment in full. So a token echoed back by a failing API call, or a
connection string a model printed, would otherwise land in
`ralph/logs/*.log` in cleartext. Every line printed goes through the redactor
first, built from the same `ralph/runner-signals.json` that
`ralph/runner-failure.ts` uses: one pattern file, because a redactor that
strips a value in the durable record and prints it in the transcript two lines
earlier has protected nothing.

**It surfaces denials as they pass.** A permission denial or an expired
credential is the difference between an iteration that is slow and one that
cannot finish, and until the stage exits nothing downstream knows. Each one is
printed the moment it goes by — `!! permission-denied: …` — and, when a signal
file is named, appended to it with the time it was seen. That timestamp is what
lets `runner-failure.ts` say `live` or `post-hoc` HONESTLY: a harness that
block-buffers its event stream into a pipe delivers every signal in the same
instant as its own exit, and calling that "live" because the renderer emitted
it would be a claim about visibility that nobody ever got.

Signals are read off ERROR-bearing events only — a failed tool result, an
`error` item, a diagnostic that is not JSON at all. Never off assistant prose:
a review whose report discusses a permission denial is a review that worked.

And each signal says WHICH CHANNEL it came from, because the two are not
equally trustworthy. `runner` is the harness speaking — its own stderr, a codex
`error` or `turn.failed` event, Claude's `permission_denials` list, the error
opencode threw for a refused tool. `tool` is the output of a command the model
ran, which is whatever the code under test happened to print: on 2026-09-23 a
failing vitest run's `"Internal server error"` and a source comment about "an
unauthorized request" were recorded as provider and credential failures, and
the operator was paged three times for a credential that was fine. So tool
output is only ever read for a RAIL REFUSAL (`toolOutputKinds`) — the one kind that
can surface nowhere else — and `runner-failure.ts` decides what a tool-sourced
signal is worth against the exit status.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from timeline import TimelineWriter, iteration_number, received_now

CONFIG_PATH = Path(__file__).resolve().parent / "runner-signals.json"
DELEGATED_STAGES = frozenset(("executor", "mapper", "review.standards", "review.spec", "review.correctness"))

# The only kinds a command's own output may raise, when the pattern file does
# not say (`failureSignals.toolOutputKinds` is the real list). A sandbox or
# permission refusal comes back as a failed command's output and nowhere else;
# every other kind — a credential, a provider error, a timeout, a missing
# binary — is something the harness reports on its own channel, and finding the
# words in a test log or a `grep` is finding the code under test, not the runner.
DEFAULT_TOOL_KINDS = frozenset(("permission-denied",))


def tool_output_kinds(config: dict) -> "frozenset[str]":
    listed = (config.get("failureSignals") or {}).get("toolOutputKinds")
    if isinstance(listed, list) and all(isinstance(kind, str) for kind in listed):
        return frozenset(listed)
    return DEFAULT_TOOL_KINDS


def load_config() -> dict:
    """The shared patterns, or nothing at all.

    A missing or unparseable pattern file must not take the renderer down: it
    is the thing that puts the harness's output in front of the orchestrator,
    and losing a whole stage's report because a JSON file was mid-edit is a
    worse failure than the one this file exists to catch. The caller is told,
    on stderr, that it is running without redaction — silence there would let a
    log fill with cleartext credentials and look completely normal.
    """
    try:
        config = json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError) as error:
        print(f"delegate-render: no {CONFIG_PATH.name} ({error}); NOT redacting", file=sys.stderr)
        return {}
    if config.get("version") != 1:
        print(f"delegate-render: unsupported {CONFIG_PATH.name}; NOT redacting", file=sys.stderr)
        return {}
    return config


def _any_of(patterns: list) -> "re.Pattern | None":
    return re.compile("|".join(patterns), re.IGNORECASE) if patterns else None


def build_redactor(config: dict, env: dict):
    """Struck values first, then struck shapes. Mirrors `buildRedactor` in TS."""
    rules = (config.get("secretEnvNames") or {})
    match = _any_of(rules.get("match") or [])
    never = _any_of((rules.get("never") or {}).get("match") or [])
    except_ = _any_of((rules.get("never") or {}).get("except") or [])
    minimum = int(rules.get("minimumValueLength") or 8)

    values = []
    for name, value in env.items():
        if not isinstance(value, str) or len(value) < minimum:
            continue
        if not (match and match.search(name)):
            continue
        if never and never.search(name) and not (except_ and except_.search(name)):
            continue
        values.append((value, f"env:{name}"))
        # The JSON-escaped form, for the reason `secretValuesFrom` gives: the
        # same patterns are used by the filter that guards the RAW event log,
        # where every value sits inside a JSON string.
        escaped = json.dumps(value)[1:-1]
        if escaped != value:
            values.append((escaped, f"env:{name}"))
        # A multi-line value is registered line by line too, and for the reason
        # `secretValuesFrom` in runner-failure.ts gives: this renderer sees one
        # line at a time, so a PEM private key or a wrapped connection string
        # in an environment variable can never match as a whole.
        if "\n" in value:
            for line in value.splitlines():
                if len(line.strip()) >= minimum:
                    values.append((line.strip(), f"env:{name}"))
    # Longest first: a value containing another (a connection string holding a
    # password) has to be struck whole, or the shorter match leaves the rest of
    # the credential sitting around a placeholder.
    values.sort(key=lambda pair: len(pair[0]), reverse=True)
    compiled_values = [(re.compile(re.escape(value)), label) for value, label in values]

    shapes = []
    for entry in ((config.get("secretPatterns") or {}).get("patterns") or []):
        try:
            shapes.append((re.compile(entry["pattern"], re.IGNORECASE), entry["label"]))
        except (KeyError, re.error) as error:
            print(f"delegate-render: skipping bad secret pattern ({error})", file=sys.stderr)

    def redact(text: str) -> str:
        # A callable replacement, not a string: `re.sub` expands `\1` and
        # `\g<name>` inside a replacement STRING, and the labels are built from
        # environment variable names. Nothing that could expand can arrive
        # there today, but a callable costs nothing and the failure it prevents
        # is a placeholder that puts the matched secret back.
        for pattern, label in compiled_values:
            text = pattern.sub(lambda _match, label=label: f"[redacted:{label}]", text)
        for pattern, label in shapes:
            text = pattern.sub(lambda _match, label=label: f"[redacted:{label}]", text)
        return text

    return redact


def build_classifier(config: dict):
    """Kinds in file order, which IS the precedence — see the pattern file."""
    kinds = []
    benign = _any_of((config.get("failureSignals") or {}).get("benignLines") or [])
    for spec in ((config.get("failureSignals") or {}).get("kinds") or []):
        pattern = _any_of(spec.get("patterns") or [])
        if pattern is not None:
            kinds.append((spec["kind"], pattern))

    def classify(text: str, only: "frozenset[str] | None" = None):
        if benign is not None and benign.search(text):
            return None
        for kind, pattern in kinds:
            if only is not None and kind not in only:
                continue
            if pattern.search(text):
                return kind
        return None

    return classify

# Compact hints per tool, so the stream reads like the pretty renderer.
HINT_KEYS = ("command", "filePath", "file_path", "path", "pattern", "query", "description")

# The floor used when the pattern file cannot supply a bound. The number itself
# lives in `runner-signals.json` beside the patterns, because both readers apply
# it and a bound that is 300 here and 400 there is the drift the shared file
# exists to prevent.
DEFAULT_EVIDENCE_MAX_CHARS = 300


class Sink:
    """Everything on its way out of this process goes through one object.

    Two jobs that both have to happen on EVERY line, which is exactly why they
    are not two passes: redact what is printed, and notice a denial or an
    expired credential while the run is still going. A second code path that
    printed without passing here is how a log comes to carry one cleartext
    token, so there is only the one — `render_codex` and the opencode branch
    both call `say` and neither has a `print` of its own.

    `error` is separate from `say` because the classification depends on WHICH
    STREAM a line came from, not on its words. A failed tool result is
    evidence; a review saying "this path is permission denied" is a working
    review. Only the caller knows which it is holding, so only the caller can
    say — and callers that are unsure must use `say`.
    """

    def __init__(
        self,
        redact,
        classify,
        signal_path: "Path | None",
        max_chars: int,
        tool_kinds: "frozenset[str]" = DEFAULT_TOOL_KINDS,
    ):
        self._redact = redact
        self._classify = classify
        self._signal_path = signal_path
        self._max_chars = max_chars
        self._tool_kinds = tool_kinds
        self.signals = 0

    def redact(self, text: str) -> str:
        """The redactor, for callers that must scrub BEFORE they truncate."""
        return self._redact(text)

    def say(self, text: str) -> None:
        print(self._redact(text), flush=True)

    def error(self, text: str, prefix: str = "  ! ", quiet: bool = False) -> "str | None":
        """An error line from the HARNESS itself: its stderr, its error events.

        Printed, and raised as a `runner` signal if it is one of the kinds.
        `quiet` records the signal without printing the line again, for a
        refusal the operator has already been shown once as a tool result.
        """
        return self._emit(text, prefix, "runner", None, quiet)

    def tool_error(self, text: str, prefix: str = "  ! ") -> "str | None":
        """A failed command's OUTPUT: what the code under test printed.

        Printed like any error, but only a rail refusal is read out of it; see
        `DEFAULT_TOOL_KINDS` for why nothing else is.
        """
        return self._emit(text, prefix, "tool", self._tool_kinds, False)

    def _emit(self, text: str, prefix: str, source: str, only, quiet: bool) -> "str | None":
        safe = self._redact(text)
        kind = self._classify(safe, only)
        if kind is None:
            if not quiet:
                print(f"{prefix}{safe}".rstrip(), flush=True)
            return None
        evidence = " ".join(safe.split())
        if len(evidence) > self._max_chars:
            evidence = evidence[: self._max_chars - 1] + "\u2026"
        # `!!` rather than `!`, because this is the line an operator scrolling a
        # live log is looking for and the ordinary errors around it are not.
        if not quiet:
            print(f"  !! {kind}: {evidence}", flush=True)
        self._record(kind, evidence, source)
        return kind

    def _record(self, kind: str, evidence: str, source: str) -> None:
        at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
        self.signals += 1
        if self._signal_path is None:
            return
        # Appended and flushed one line at a time: the reader is a separate
        # process that may look while this one is still running, and a signal
        # buffered until exit is a signal that was never live.
        try:
            with self._signal_path.open("a", encoding="utf8") as handle:
                handle.write(
                    json.dumps({"at": at, "kind": kind, "evidence": evidence, "source": source}) + "\n"
                )
                handle.flush()
        except OSError as error:
            print(f"delegate-render: could not write the signal file ({error})", file=sys.stderr)


def hint(state: dict, redact) -> str:
    """A compact tool hint, REDACTED BEFORE IT IS TRUNCATED.

    The order is the whole point. Cutting first and redacting afterwards means
    an exact environment value split by the cut no longer matches anything, so
    `--key ABCDEF…` reaches the log as a 30-character prefix of a real
    credential — and a prefix is quite enough to be worth having. Every other
    truncation in this file follows the same rule for the same reason.
    """
    inp = state.get("input")
    if not isinstance(inp, dict):
        return ""
    for k in HINT_KEYS:
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = redact(" ".join(v.split()))
            return v if len(v) <= 100 else v[:97] + "..."
    return ""


def render_codex(ev: dict, totals: dict, state: dict, out: Sink) -> None:
    """One codex `--json` event.

    Codex reports tokens per turn. Those exact counts are all the usage ledger
    needs.
    """
    kind = ev.get("type")

    if kind == "item.completed":
        item = ev.get("item") or {}
        itype = item.get("type")
        if itype == "agent_message":
            text = (item.get("text") or "").rstrip()
            if text:
                state["text"] = True
                out.say(text)
        elif itype == "command_execution":
            state["text"] = False
            # Redacted before the cut, for the reason `hint` gives.
            cmd = out.redact(" ".join((item.get("command") or "").split()))
            out.say(f"  → bash{': ' + (cmd if len(cmd) <= 100 else cmd[:97] + '...') if cmd else ''}")
            # A command the sandbox refused comes back here, not as an `error`
            # item — a non-zero status with the refusal in its output — so this
            # is where a codex stage's denials actually are. It is ALSO where a
            # failing test suite's whole output is, which is why it is read for
            # a refusal and nothing else.
            status = item.get("exit_code")
            if isinstance(status, int) and status != 0:
                detail = " ".join(str(item.get("aggregated_output") or "").split())
                out.tool_error(f"bash exited {status}: {detail}".rstrip(), prefix="  ! ")
        elif itype == "error":
            # A codex `error` item is not always fatal — a truncated skill
            # description arrives as one — so it is shown, not swallowed, and
            # not turned into an exit status this script does not own.
            out.error(str(item.get("message", "")))
        elif itype in ("file_change", "web_search", "mcp_tool_call"):
            state["text"] = False
            out.say(f"  → {itype}")

    elif kind == "error":
        # Codex's own failure channel: a stream or provider error — a 401, a
        # 429, a disconnect — arrives as a top-level event, never inside a
        # command's output.
        out.error(f"codex: {' '.join(str(ev.get('message') or 'error').split())}")

    elif kind == "turn.failed":
        err = ev.get("error")
        message = err.get("message") if isinstance(err, dict) else err
        out.error(f"codex turn failed: {' '.join(str(message or 'no message').split())}")

    elif kind == "turn.completed":
        u = ev.get("usage") or {}
        state["steps"] += 1
        # `input_tokens` INCLUDES `cached_input_tokens` here — the OpenAI
        # convention, and the opposite of opencode's, which reports `input`
        # with the cache read taken out (a real step: input 3, cache.read
        # 51231). Adding both would book the cached half twice, and the ledger
        # sums input and cache_read into the one "in" figure it prints, so a
        # codex stage with a 76% cache hit — an ordinary long review — would
        # report nearly double the context it actually sent.
        cached = int(u.get("cached_input_tokens") or 0)
        uncached = int(u.get("input_tokens") or 0) - cached
        totals["input"] += max(0, uncached)
        totals["output"] += int(u.get("output_tokens") or 0)
        totals["cache_read"] += cached
        totals["cache_write"] += int(u.get("cache_write_input_tokens") or 0)

    elif kind == "thread.started":
        state["session"] = ev.get("thread_id") or state["session"]


def _claude_text(content) -> str:
    """A tool result's text, whichever of the two shapes the harness used."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(c.get("text") or "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        )
    return ""


def render_claude(ev: dict, totals: dict, state: dict, out: Sink) -> None:
    """One Claude Code `-p --output-format stream-json` event.

    Three shapes matter. `assistant` carries the model's text and its tool
    calls; `user` carries each tool's result, and a refused tool comes back
    there with `is_error` and the refusal as its text — the run keeps going
    and can still exit 0, exactly the shape the opencode branch exists for.
    `result` closes the run with the usage totals, the session id, and a
    `permission_denials` list the harness kept itself. That list is the one
    denial record no text pattern can miss, so every entry in it that no
    tool result already raised is raised here — deduplicated on the tool-use
    id, because the same refusal usually arrives both ways.
    """
    kind = ev.get("type")
    reported_model = (ev.get("message") or {}).get("model") if kind == "assistant" else ev.get("model")
    if isinstance(reported_model, str) and reported_model.startswith("claude-"):
        state["model"] = reported_model

    if kind == "system":
        if ev.get("subtype") == "init":
            state["session"] = ev.get("session_id") or state["session"]

    elif kind == "assistant":
        for c in (ev.get("message") or {}).get("content") or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text":
                text = (c.get("text") or "").rstrip()
                if text:
                    state["text"] = True
                    out.say(text)
            elif c.get("type") == "tool_use":
                state["text"] = False
                call = c.get("id") or ""
                if call:
                    state["calls"][call] = c.get("name") or "tool"
                h = hint({"input": c.get("input")}, out.redact)
                out.say(f"  → {c.get('name', 'tool')}{': ' + h if h else ''}")

    elif kind == "user":
        for c in (ev.get("message") or {}).get("content") or []:
            if not isinstance(c, dict) or c.get("type") != "tool_result":
                continue
            # A result with no id gets one of its own, so two unkeyed errors
            # are two lines rather than one swallowed.
            call = c.get("tool_use_id") or f"result-{len(state['errored'])}"
            if c.get("is_error") and call not in state["errored"]:
                state["errored"].add(call)
                state["text"] = False
                tool = state["calls"].get(call, "tool")
                # A tool result carries whatever the tool printed — a failing
                # Bash command's whole output among it — so it is the tool
                # channel, read for a refusal and nothing else.
                if out.tool_error(f"{tool}: {' '.join(_claude_text(c.get('content')).split())}".rstrip()):
                    state["raised"].add(call)

    elif kind == "result":
        u = ev.get("usage") or {}
        # Claude reports `input_tokens` WITHOUT the cached halves — the same
        # convention as opencode, so the four figures book straight through.
        totals["input"] += int(u.get("input_tokens") or 0)
        totals["output"] += int(u.get("output_tokens") or 0)
        totals["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
        totals["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
        state["steps"] += max(1, int(ev.get("num_turns") or 0))
        state["session"] = ev.get("session_id") or state["session"]
        for d in ev.get("permission_denials") or []:
            if not isinstance(d, dict):
                continue
            # The harness's own list, so the RUNNER channel — and raised for
            # every entry, even one already raised off its tool result: that
            # one was tool-sourced, and a clean exit is classified from the
            # runner channel alone. Printed only if the operator has not
            # already been shown the refusal as a `!!` line.
            call = d.get("tool_use_id") or ""
            state["errored"].add(call or f"denial-{len(state['errored'])}")
            h = hint({"input": d.get("tool_input")}, out.redact)
            out.error(
                f"{d.get('tool_name', 'tool')}: permission denied{': ' + h if h else ''}",
                quiet=bool(call) and call in state["raised"],
            )
        if ev.get("is_error"):
            out.error(f"claude -p: {' '.join(str(ev.get('result') or 'is_error').split())}")
        elif isinstance(ev.get("result"), str) and ev["result"].strip():
            if not state["text"]:
                out.say(ev["result"].rstrip())
            state["text"] = True


def main() -> int:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
    model = sys.argv[2] if len(sys.argv) > 2 else "unknown"
    fmt = sys.argv[3] if len(sys.argv) > 3 else "opencode"
    # Optional, and optional on purpose: a hand-run `delegate.sh` still renders
    # and still redacts without one. Only the durable half needs the file.
    signal_path = Path(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
    extra = sys.argv[5:]
    timeline_value = os.environ.get("RALPH_TIMELINE")
    timeline_path = Path(timeline_value) if timeline_value else None
    stage = os.environ.get("RALPH_TIMELINE_STAGE") or None
    while extra:
        option = extra.pop(0)
        if option == "--timeline" and extra:
            timeline_path = Path(extra.pop(0))
        elif option == "--stage" and extra:
            stage = extra.pop(0)
        else:
            print(f"delegate-render: unknown or incomplete option {option}", file=sys.stderr)
            return 2
    if (timeline_path is None) != (stage is None):
        print("delegate-render: --timeline and --stage must be supplied together", file=sys.stderr)
        return 2
    if stage is not None and stage not in DELEGATED_STAGES:
        print(
            f"delegate-render: --stage must be one of {', '.join(sorted(DELEGATED_STAGES))}",
            file=sys.stderr,
        )
        return 2

    config = load_config()
    max_chars = config.get("evidenceMaxChars")
    if not isinstance(max_chars, int) or max_chars <= 0:
        max_chars = DEFAULT_EVIDENCE_MAX_CHARS
    out = Sink(
        build_redactor(config, os.environ),
        build_classifier(config),
        signal_path,
        max_chars,
        tool_output_kinds(config),
    )
    timeline = (
        TimelineWriter(
            timeline_path,
            stage,
            iteration_number(os.environ.get("RALPH_ITERATION")),
            os.environ.get("RALPH_RUN_ID"),
        )
        if timeline_path is not None and stage is not None
        else None
    )

    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    steps = 0
    session = ""
    seen: set[str] = set()
    errored: set[str] = set()
    said_text = False
    codex_state = {"steps": 0, "session": "", "text": False}
    claude_state = {"steps": 0, "session": "", "text": False, "calls": {}, "errored": set(), "raised": set()}

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except ValueError:
            # Not an event: both harnesses write plain diagnostics to the same
            # stream. Pass it through rather than swallowing an error message —
            # and classify it, because `2>&1` means the harness's OWN stderr
            # arrives here, which is where "not logged in" and a rate limit are
            # printed. Nothing a model wrote reaches this branch: assistant
            # prose comes through as an event.
            if timeline is not None:
                timeline.append({"type": "invalid", "raw": out.redact(raw)}, received_now())
            out.error(raw, prefix="")
            continue

        if timeline is not None:
            serialized = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
            redacted_event = json.loads(out.redact(serialized))
            timeline.append(redacted_event, received_now())

        if fmt == "codex":
            render_codex(ev, totals, codex_state, out)
            continue
        if fmt == "claude":
            render_claude(ev, totals, claude_state, out)
            continue

        part = ev.get("part") or {}
        kind = ev.get("type")
        session = ev.get("sessionID") or session

        if kind == "tool_use":
            # One event per state transition, and the two things worth reading
            # arrive on DIFFERENT transitions of the same call: the announcement
            # on the first, and the refusal — if the rails refuse it — on a
            # later one. So the dedup is per (call, thing said) rather than per
            # call, which is what the single `seen` set used to be. Dropping
            # every repeat of a callID is why a denied tool used to leave no
            # trace at all: its error state is always a repeat.
            call = part.get("callID") or part.get("id") or ""
            tool_state = part.get("state") or {}
            if call not in seen:
                seen.add(call)
                said_text = False
                h = hint(tool_state, out.redact)
                out.say(f"  → {part.get('tool', 'tool')}{': ' + h if h else ''}")
            # A tool the rails refused fails HERE, and only here: opencode
            # reports the denial as the tool call's own error state, the run
            # keeps going, and the stage can still exit 0 having quietly done
            # none of what it was asked. Without this the one failure the loop
            # most needs to see is in neither the log nor the record.
            if tool_state.get("status") == "error" and call not in errored:
                errored.add(call)
                said_text = False
                # `error` is the message opencode itself threw — the refusal,
                # when the rails refused — so it is the runner channel. The
                # `output` fallback is what the tool printed, and is read the
                # way every other tool output is: for a refusal only.
                tool = part.get("tool", "tool")
                if tool_state.get("error"):
                    out.error(f"{tool}: {tool_state.get('error')}".rstrip())
                else:
                    detail = tool_state.get("output") or tool_state.get("message") or ""
                    out.tool_error(f"{tool}: {detail}".rstrip())

        elif kind == "text":
            text = (part.get("text") or "").rstrip()
            if text:
                said_text = True
                out.say(text)

        elif kind == "error":
            # opencode's own failure channel, like codex's `error` event: a
            # refusal before any tool runs — "Unexpected server error", an
            # expired key — arrives as a top-level event and nowhere else.
            # Unrendered, it left an empty log and no signal.
            said_text = False
            err = ev.get("error")
            message = None
            status = None
            if isinstance(err, dict):
                data = err.get("data")
                if isinstance(data, dict):
                    message = data.get("message")
                    status = data.get("statusCode")
                message = message or err.get("message") or err.get("name")
            elif err:
                message = err
            message = " ".join(str(message or ev.get("message") or "error").split())
            # A provider's 401 or 429 wording carries no keyword of its own
            # ("invalid x-api-key"); opencode keeps the code beside it, so it is
            # put on the line for the status patterns to read. Only the code:
            # the provider's response body stays out of the log.
            if isinstance(status, int) and str(status) not in message:
                message = f"{message} (status {status})"
            out.error(f"opencode: {message}")

        elif kind == "step_finish":
            steps += 1
            tok = part.get("tokens") or {}
            cache = tok.get("cache") or {}
            totals["input"] += int(tok.get("input") or 0)
            totals["output"] += int(tok.get("output") or 0)
            totals["cache_read"] += int(cache.get("read") or 0)
            totals["cache_write"] += int(cache.get("write") or 0)

    if fmt == "codex":
        steps = codex_state["steps"]
        session = codex_state["session"]
        said_text = codex_state["text"]
    elif fmt == "claude":
        steps = claude_state["steps"]
        session = claude_state["session"]
        said_text = claude_state["text"]
        model = claude_state.get("model") or model

    # THE USAGE FILE IS SOURCED BY A SHELL, so everything written into it is
    # code. `delegate.sh` and `inspect.sh` both run `. "$usage"` — under the
    # orchestrator's full Doppler environment — to book the usage, and
    # `sessionID` comes straight off the harness's event stream. A session id
    # of `x\nEVIL=$(curl …)` therefore ran arbitrary commands with every
    # credential in scope, which would make the rest of this file's redaction
    # beside the point: a runner that can execute does not need to leak.
    #
    # This predates the observability work and was found reviewing it. The fix
    # is at the WRITE, not at the two reads: the values are the untrusted part,
    # and there is no reason for any of them to carry a character that is not
    # in an identifier. Counts are coerced through `int` for the same
    # reason, since they are read off the same stream.
    def shell_safe(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.:/@-]", "", str(value))[:200]

    if out_path:
        out_path.write_text(
            f"DELEGATE_MODEL={shell_safe(model)}\n"
            f"DELEGATE_INPUT={int(totals['input'])}\n"
            f"DELEGATE_OUTPUT={int(totals['output'])}\n"
            f"DELEGATE_CACHE_READ={int(totals['cache_read'])}\n"
            f"DELEGATE_CACHE_WRITE={int(totals['cache_write'])}\n"
            f"DELEGATE_STEPS={int(steps)}\n"
            f"DELEGATE_TEXT={1 if said_text else 0}\n"
            f"DELEGATE_SESSION={shell_safe(session)}\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
