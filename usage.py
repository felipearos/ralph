#!/usr/bin/env python3
"""Ralph token-usage reporter.

Reads the CURRENT iteration's session transcript (the JSONL Claude Code writes
under ~/.claude/projects/<slug>/<session-id>.jsonl) and reports token usage,
model mix and context-window occupancy at three scopes:

  step       — everything since the last time this script was called
  iteration  — the whole of this `claude -p` session, plus the earlier
               sessions of the same iteration (RALPH_ITERATION_SESSIONS)
  run        — every step of every iteration in this ralph.sh run

Ralph calls it before each GitHub comment and pastes the markdown verbatim:

    ralph/usage.py --step "claimed #544" --md

`--json` prints the same three scopes as one machine-readable object instead of
the human lines, so a panel or another script can consume usage without parsing
prose. The shape is stable: every token count is a raw integer, `context.window`
is null when the model is unknown, and human-formatted strings ride alongside
their numeric source (for example `elapsed` and `elapsed_seconds`). The keys are
`session`, `run_id`, `step`, `iteration`, `run`, and `context`; each of the three
scopes carries a `usage` object with `input`, `output`, `cache_5m`, `cache_1h`,
`cache_read`, and `input_total` (the sum of the non-output columns).

Scope plumbing (both set by ralph.sh, both optional):
  RALPH_SESSION_ID  the uuid passed to `claude -p --session-id`; without it we
                    fall back to the newest transcript for this cwd, which is
                    right in practice but not guaranteed under concurrency.
  RALPH_RUN_ID      identifies one ralph.sh invocation, so `run` totals can
                    span the iterations it has already finished.
  RALPH_ITERATION_SESSIONS
                    every session id this iteration has run, space-separated.
                    An iteration continues in a FRESH session after the
                    supervisor waits on its PR or stops it at the token cap;
                    the earlier sessions' ledger rows fold into `iteration`.

Every step is appended to <project>/.ralph/logs/usage-ledger.tsv, which is the source of
truth for run totals and survives across iterations.

Delegated executors (ralph/delegate.sh) write no Claude transcript, so they
record themselves into the same ledger:

    ralph/usage.py --record-external opencode-go/deepseek-v4-flash \
        --input N --output N --cache-read N --step "..."

Those rows are folded back into all three scopes by model id. With none
present — delegation off, or pure Claude Code — every number here is exactly
what it was before delegation existed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

RALPH_DIR = Path(__file__).resolve().parent


def _project_root() -> Path:
    """The project worktree: RALPH_PROJECT, else the git toplevel, else cwd."""
    override = os.environ.get("RALPH_PROJECT", "").strip()
    if override:
        return Path(override).resolve()
    try:
        import subprocess

        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout.strip()
        if top:
            return Path(top).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.cwd().resolve()


LOGS = _project_root() / ".ralph" / "logs"
LEDGER = LOGS / "usage-ledger.tsv"
LEGACY_LEDGER = LOGS / "cost-ledger.tsv"

# Context windows only. Token accounting never depends on this table: an
# unknown model still reports every token and loses only the occupancy figure.
# Longest-prefix match tolerates dated and suffixed model ids.
CONTEXT_WINDOWS = {
    "claude-fable-5-1": 1_000_000,
    "claude-fable-5": 1_000_000,
    "claude-opus-5": 1_000_000,
    "claude-opus-4-8": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-5": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
    "opencode-go/deepseek-v4-flash": 1_000_000,
    "opencode-go/deepseek-v4-pro": 1_000_000,
    "opencode-go/gpt-5.6-luna": 1_050_000,
    "opencode-go/glm-5.1": 202_752,
    "opencode-go/glm-5.2": 1_000_000,
    "opencode-go/glm-5.3": 1_000_000,
    "opencode-go/grok-4.5": 500_000,
    "opencode-go/hy3": 256_000,
    "opencode-go/kimi-k2.6": 262_144,
    "opencode-go/kimi-k2.7-code": 262_144,
    "opencode-go/kimi-k3": 1_048_576,
    "opencode-go/mimo-v2.5": 1_000_000,
    "opencode-go/mimo-v2.5-pro": 1_048_576,
    "opencode-go/minimax-m2.7": 204_800,
    "opencode-go/minimax-m3": 1_000_000,
    "opencode-go/qwen3.6-plus": 1_000_000,
    "opencode-go/qwen3.7-plus": 1_000_000,
    "opencode-go/qwen3.7-max": 1_000_000,
    "opencode-go/qwen3.8-max": 1_000_000,
    "codex/": 400_000,
}

FIELDS = ("input", "output", "cache_5m", "cache_1h", "cache_read")


def adopt_legacy_file(legacy: Path, current: Path) -> None:
    """Move one legacy file without clobbering a concurrent writer."""
    if current.exists() or not legacy.exists():
        return
    try:
        os.link(legacy, current)
    except (FileExistsError, FileNotFoundError):
        return
    legacy.unlink()


def migrate_legacy_ledger() -> None:
    adopt_legacy_file(LEGACY_LEDGER, LEDGER)


def context_window(model: str) -> int | None:
    model = (model or "").split("[")[0]
    best = None
    for prefix, window in CONTEXT_WINDOWS.items():
        if model.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, window)
    return best[1] if best else None


def is_external(model: str) -> bool:
    """True for a delegated executor (ralph/delegate.sh).

    Claude Code writes bare model ids; delegated rows are always recorded in
    `provider/model` form, so the slash is the discriminator. Nothing else in
    this file needs to know what a delegate is.
    """
    return "/" in (model or "")


def zero() -> dict:
    return {f: 0 for f in FIELDS}


def transcript_path(session_id: str | None) -> Path | None:
    if session_id:
        codex = Path(os.environ.get("RALPH_LOG_DIR", str(LOGS))) / f"codex-orchestrator-{session_id}.jsonl"
        if codex.exists():
            return codex
        if os.environ.get("RALPH_RUNNER_ORCHESTRATOR") == "codex":
            return None
    # Claude Code names the project dir after the cwd of the `claude` process,
    # which is the repo root; tolerate being invoked from a subdirectory.
    root = Path.home() / ".claude" / "projects"
    proj = None
    for d in [Path.cwd(), *Path.cwd().parents]:
        cand = root / str(d).replace("/", "-").replace(".", "-").replace("_", "-")
        if cand.is_dir():
            proj = cand
            break
    if proj is None:
        return None
    if session_id:
        p = proj / f"{session_id}.jsonl"
        return p if p.exists() else None
    files = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def _transcript_lines(path: Path):
    """(is_subagent, line) for the session's transcript, then its subagents' (see `parse`)."""
    files = [(False, path), *((True, f) for f in sorted((path.parent / path.stem / "subagents").glob("*.jsonl")))]
    for is_subagent, file in files:
        with file.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                yield is_subagent, line


def parse(path: Path):
    """Return (per-model usage, context snapshot, first/last timestamps, turns).

    Assistant messages are deduped by message id: a single API response is
    written as several transcript lines (thinking, text, each tool_use) that
    all carry the same id and the same usage, so summing lines double-counts.

    Subagents' turns are read too. Claude Code writes them beside the session,
    in `<session>/subagents/agent-*.jsonl`, not in it, and each record names
    the model that actually ran. That is what attributes a named review agent's
    spend to `claude-opus-5-5` rather than to whatever an alias table said
    `opus` meant.
    """
    seen: set[str] = set()
    models: dict[str, dict] = {}
    ctx = {"tokens": 0, "model": None}
    first = last = None
    turns = 0

    for is_subagent, line in _transcript_lines(path):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        u = msg.get("usage") or {}
        if not u:
            continue
        mid = msg.get("id")
        if mid in seen:
            continue
        if mid:
            seen.add(mid)
        model = msg.get("model") or "unknown"
        if model.startswith("<"):
            continue
        cc = u.get("cache_creation") or {}
        row = models.setdefault(model, zero())
        row["input"] += u.get("input_tokens", 0) or 0
        row["output"] += u.get("output_tokens", 0) or 0
        row["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
        c5 = cc.get("ephemeral_5m_input_tokens")
        c1h = cc.get("ephemeral_1h_input_tokens")
        if c5 is None and c1h is None:
            # Older transcripts only carry the flat total; record it as 5m.
            c5, c1h = u.get("cache_creation_input_tokens", 0) or 0, 0
        row["cache_5m"] += c5 or 0
        row["cache_1h"] += c1h or 0
        turns += 1

        # min/max, not first/last seen: subagent files are read after the
        # session's, so file order is not time order.
        ts = rec.get("timestamp")
        if ts:
            first = min(first, ts) if first else ts
            last = max(last, ts) if last else ts
        # context occupancy = what the main chain last sent upstream;
        # sidechains are subagents with their own separate windows. A record
        # from a subagent file is one whether or not it says so.
        if not is_subagent and not rec.get("isSidechain"):
            ctx = {
                "tokens": (u.get("input_tokens", 0) or 0)
                + (u.get("cache_read_input_tokens", 0) or 0)
                + (c5 or 0)
                + (c1h or 0),
                "model": model,
            }
    return models, ctx, first, last, turns


def total(models: dict) -> dict:
    t = zero()
    for row in models.values():
        for f in FIELDS:
            t[f] += row[f]
    return t


def state_file(session: str) -> Path:
    return LOGS / f"usage-state-{session}.json"


def legacy_state_file(session: str) -> Path:
    return LOGS / f"cost-state-{session}.json"


def read_state(session: str) -> dict:
    adopt_legacy_file(legacy_state_file(session), state_file(session))
    try:
        return json.loads(state_file(session).read_text())
    except Exception:
        return {"step": 0, "models": {}}


def write_state(session: str, step: int, models: dict) -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    state_file(session).write_text(json.dumps({"step": step, "models": models}))


def delta(now: dict, before: dict) -> dict:
    out: dict[str, dict] = {}
    for model, row in now.items():
        prev = before.get(model, zero())
        d = {f: row[f] - prev.get(f, 0) for f in FIELDS}
        if any(d[f] for f in FIELDS):
            out[model] = d
    return out


def append_ledger(run_id, session, step_no, label, models) -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    new = not LEDGER.exists()
    with LEDGER.open("a", encoding="utf-8") as fh:
        if new:
            fh.write("run_id\tsession\tstep\tts\tlabel\tmodel\t"
                     + "\t".join(FIELDS) + "\n")
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        safe = (label or "").replace("\t", " ").replace("\n", " ")
        for model, u in models.items():
            fh.write(
                f"{run_id}\t{session}\t{step_no}\t{ts}\t{safe}\t{model}\t"
                + "\t".join(str(u[f]) for f in FIELDS)
                + "\n"
            )


def read_ledger(run_id: str, exclude_session: str | None = None,
                only_sessions: set[str] | None = None):
    models: dict[str, dict] = {}
    steps = 0
    if not LEDGER.exists():
        return models, steps
    seen_steps = set()
    with LEDGER.open(encoding="utf-8") as fh:
        next(fh, None)
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            # Eleven columns is the token-only schema. A legacy twelfth
            # cost_usd column is ignored so an in-flight run survives rollout.
            if len(parts) < 11 or parts[0] != run_id:
                continue
            if exclude_session and parts[1] == exclude_session:
                continue
            if only_sessions is not None and parts[1] not in only_sessions:
                continue
            seen_steps.add((parts[1], parts[2]))
            row = models.setdefault(parts[5], zero())
            for i, f in enumerate(FIELDS):
                row[f] += int(parts[6 + i] or 0)
    return models, len(seen_steps)


def read_external(run_id: str, session: str, step_no: int | None = None):
    """Delegated-executor rows this session has already recorded.

    Delegated usage leaves no Claude transcript, so it reaches the report only
    through the ledger. `step_no` narrows to one step; omit it for the whole
    iteration. Returns an empty dict when nothing was delegated, which is what
    makes every number here identical to a pure-Claude run.
    """
    models: dict[str, dict] = {}
    if not LEDGER.exists():
        return models
    with LEDGER.open(encoding="utf-8") as fh:
        next(fh, None)
        for line_ in fh:
            parts = line_.rstrip("\n").split("\t")
            if len(parts) < 11 or parts[0] != run_id or parts[1] != session:
                continue
            if not is_external(parts[5]):
                continue
            if step_no is not None and parts[2] != str(step_no):
                continue
            row = models.setdefault(parts[5], zero())
            for i, f in enumerate(FIELDS):
                row[f] += int(parts[6 + i] or 0)
    return models


def merge(*dicts: dict) -> dict:
    out: dict[str, dict] = {}
    for d in dicts:
        for model, u in d.items():
            row = out.setdefault(model, zero())
            for f in FIELDS:
                row[f] += u[f]
    return out


def human(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def line(models: dict) -> str:
    t = total(models)
    return (
        f"{human(t['input'] + t['cache_5m'] + t['cache_1h'] + t['cache_read'])} in "
        f"({human(t['input'])} uncached, {human(t['cache_read'])} cache read, "
        f"{human(t['cache_5m'])} 5m write, {human(t['cache_1h'])} 1h write) / "
        f"{human(t['output'])} out"
    )


def mix(models: dict) -> str:
    parts = []
    def tokens(item):
        return sum(item[1][field] for field in FIELDS)

    for model, u in sorted(models.items(), key=tokens, reverse=True):
        parts.append(f"{model} {line({model: u})}")
    return ", ".join(parts) or "—"


def elapsed_seconds(first: str | None, last: str | None) -> int | None:
    if not (first and last):
        return None
    try:
        a = datetime.fromisoformat(first.replace("Z", "+00:00"))
        b = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int((b - a).total_seconds()))


def elapsed(first: str | None, last: str | None) -> str:
    secs = elapsed_seconds(first, last)
    if secs is None:
        return "—"
    return f"{secs // 60}m{secs % 60:02d}s"


def usage_json(models: dict) -> dict:
    """One scope's totals as raw integers, ledger field names preserved."""
    t = total(models)
    return {
        "input": t["input"],
        "output": t["output"],
        "cache_5m": t["cache_5m"],
        "cache_1h": t["cache_1h"],
        "cache_read": t["cache_read"],
        "input_total": t["input"] + t["cache_5m"] + t["cache_1h"] + t["cache_read"],
    }


def record_external(args) -> int:
    """Append one delegated-executor row to the ledger.

    Attributed to the step Ralph will report next, so the usage surfaces in the
    same footer as the orchestration that caused it. This must never break the
    loop: a failure here loses an accounting row, not an iteration.
    """
    model = args.record_external
    u = zero()
    u["input"] = max(0, args.input)
    u["output"] = max(0, args.output)
    u["cache_read"] = max(0, args.cache_read)
    u["cache_5m"] = max(0, args.cache_write)

    session = args.session
    if not session:
        path = transcript_path(None)
        session = path.stem if path else "external"

    step_no = int(read_state(session).get("step", 0)) + 1
    append_ledger(args.run_id, session, step_no, args.step or "delegated", {model: u})
    if args.json:
        print(json.dumps({
            "recorded": {
                "session": session,
                "run_id": args.run_id,
                "step": step_no,
                "label": args.step or "delegated",
                "model": model,
                "usage": usage_json({model: u}),
            },
        }, indent=2))
    print(f"usage: recorded {model} — {line({model: u})} (step {step_no})",
          file=sys.stderr)
    return 0


def main() -> int:
    migrate_legacy_ledger()
    ap = argparse.ArgumentParser(description="Ralph per-step / per-run token usage report")
    ap.add_argument("--step", default="", help="label for this step")
    ap.add_argument("--md", action="store_true", help="markdown for a GitHub comment")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable report as a JSON object")
    ap.add_argument("--session", default=os.environ.get("RALPH_SESSION_ID"))
    ap.add_argument("--run-id", default=os.environ.get("RALPH_RUN_ID", "adhoc"))
    ap.add_argument("--no-record", action="store_true",
                    help="report without advancing the step baseline or ledger")
    ap.add_argument("--record-external", metavar="PROVIDER/MODEL",
                    help="record delegated executor usage (ralph/delegate.sh) "
                         "against the current step, then exit")
    for f in ("input", "output", "cache-read", "cache-write"):
        ap.add_argument(f"--{f}", type=int, default=0)
    args = ap.parse_args()

    if args.record_external:
        return record_external(args)

    path = transcript_path(args.session)
    if path is None:
        print("usage: no transcript found for this session", file=sys.stderr)
        return 1
    session = args.session or path.stem

    models, ctx, first, last, turns = parse(path)
    prev = read_state(session)
    step_models = delta(models, prev.get("models", {}))
    step_no = int(prev.get("step", 0)) + 1

    # Ledger and baseline carry the transcript only: delegated rows are already
    # in the ledger under their own model, and re-writing them here would count
    # them twice once this session becomes an "earlier" one.
    if not args.no_record:
        append_ledger(args.run_id, session, step_no, args.step, step_models)
        write_state(session, step_no, models)

    # Delegated usage has no transcript, so fold it in from the ledger. Both
    # are empty dicts when nothing was delegated — the pure-Claude path.
    ext_step = read_external(args.run_id, session, step_no)
    ext_iter = read_external(args.run_id, session)
    step_models = merge(step_models, ext_step)
    models = merge(models, ext_iter)

    earlier, earlier_steps = read_ledger(args.run_id, exclude_session=session)
    run_models = merge(earlier, models)

    # Earlier sessions of THIS iteration are in the ledger already — each was
    # closed with a usage step before the next began — so they join the
    # iteration scope from there. Run totals above already include them.
    siblings = set(os.environ.get("RALPH_ITERATION_SESSIONS", "").split()) - {session}
    if siblings:
        models = merge(models, read_ledger(args.run_id, only_sessions=siblings)[0])

    window = context_window(ctx["model"] or "")
    pct = 100 * ctx["tokens"] / window if window else 0
    label = args.step or f"step {step_no}"

    if args.json:
        # Raw numbers, never the human abbreviations: a panel formatting its own
        # labels must not have to parse "1.00M" back out of this.
        print(json.dumps({
            "session": session,
            "run_id": args.run_id,
            "step": {
                "number": step_no,
                "label": label,
                "usage": usage_json(step_models),
            },
            "iteration": {
                "turns": turns,
                "elapsed_seconds": elapsed_seconds(first, last),
                "elapsed": elapsed(first, last),
                "usage": usage_json(models),
                "models": {
                    m: usage_json({m: u})
                    for m, u in sorted(models.items(),
                                       key=lambda kv: sum(kv[1][f] for f in FIELDS),
                                       reverse=True)
                },
            },
            "run": {
                "steps": earlier_steps + step_no,
                "usage": usage_json(run_models),
            },
            "context": {
                "model": ctx["model"],
                "tokens": ctx["tokens"],
                "window": window,
                "percent": round(pct, 1),
            },
        }, indent=2))
        return 0

    if not args.md:
        print(f"step {step_no} — {label}: {line(step_models)}")
        print(f"iteration ({turns} turns, {elapsed(first, last)}): {line(models)}")
        print(f"run {args.run_id}: {line(run_models)}")
        if window:
            print(f"context: {human(ctx['tokens'])}/{human(window)} ({pct:.0f}%) "
                  f"on {ctx['model']}")
        else:
            print(f"context: {human(ctx['tokens'])} (occupancy unknown) on {ctx['model']}")
        print(f"models: {mix(models)}")
        return 0

    st, it, rt = total(step_models), total(models), total(run_models)

    def row(name, t):
        input_total = t["input"] + t["cache_5m"] + t["cache_1h"] + t["cache_read"]
        cache = (f"{human(t['cache_read'])} read / {human(t['cache_5m'])} 5m write / "
                 f"{human(t['cache_1h'])} 1h write")
        return f"| {name} | {human(input_total)} | {human(t['output'])} | {cache} |"

    print(f"<details><summary>token usage \u2014 step {step_no} \u00b7 {label} "
          f"\u00b7 {line(step_models)}</summary>\n")
    print("| scope | input tokens | output tokens | cache split |")
    print("| --- | --- | --- | --- |")
    print(row("this step", st))
    print(row(f"this iteration ({turns} turns, {elapsed(first, last)})", it))
    print(row(f"full run (`{args.run_id}`, {earlier_steps + step_no} steps)",
              rt))
    context = (f"{human(ctx['tokens'])} / {human(window)} ({pct:.0f}%)"
               if window else f"{human(ctx['tokens'])} (occupancy unknown)")
    print(f"""
- **models this iteration**: {mix(models)}
- **context window**: {context} on `{ctx['model']}`
- **cache**: {human(it['cache_read'])} read, {human(it['cache_5m'])} written 5m, {human(it['cache_1h'])} written 1h
- **session**: `{session}`

</details>""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
