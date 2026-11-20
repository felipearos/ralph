# 2026-10-06 / 2026-10-07 — Orca update killed every loop; the ci-doctor's first night

Times are local (UTC−3), with UTC in brackets where the logs record UTC.

## Timeline

| When | What |
| --- | --- |
| 2026-10-06 21:07 (00:07Z) | Orca auto-updated 1.4.220 → 1.4.221. systemd stopped the old `orca-daemon-*.scope` (up 36 h, 20.6 G peak memory), timed out and SIGKILLed it. The dashboard and all seven loops had been started from Orca terminals, so they lived in that scope and died with it. Every loop was idle on an empty frontier, so no work was lost. |
| 2026-10-06 ~21:14 | Found during a status check: no supervisor processes, dashboard not answering on :8791, last log lines 21:04–21:07. Cause read from `journalctl --user`. |
| 2026-10-06 21:15 | Deployed `~/ralph` from #227 to origin/main (9 harness PRs, #228–#236). `models.json` stash-pop conflicted as usual; merged with the documented `jq` recipe, `models.test.ts` green. |
| 2026-10-06 21:16 | Dashboard relaunched as a transient systemd user unit, `ralph-dashboard.service`, so it and every loop it starts sit in their own cgroup rather than Orca's. Loops stopped, then resumed under it. |
| 2026-10-06 ~22:00 | Onboarded the ci-doctor `doc` on loggd (#164): roster PR loggd#2130 was already merged, `RALPH_BUILDKITE_READ_TOKEN` already in Doppler. Operator added `RALPH_BUILDKITE_RETRY_TOKEN` (exactly `write_builds`, verified with `bk-log.ts --check-retry-token`). Checkout created from the dashboard; `doc` passed preflight (11 checks) and started. |
| 2026-10-06 23:52 (02:52Z) | Operator soft stop sent to all eight loops, then withdrawn. A queued stop cannot be cancelled, so the idle loops were restarted at once and the three mid-iteration ones (rafa, doc, rulo) restarted by a watcher as each reached its boundary (00:03, 00:38, 01:45). |
| 2026-10-07 00:36 (03:36Z) | `doc` merged loggd PR #2195 — fix for flake #2193 (`manage-list-collaborators`). |
| 2026-10-07 01:55 (04:55Z) | `doc` merged loggd PR #2207 — fix for flake #2206 (lapsed-session person sheet). |
| 2026-10-07 01:59 (04:59Z) | `doc` halted for repair, correctly. Its next case, "Activity tab show grouping", was not a flake: main build #3053 was starved of host, and 13 mobile tests across unrelated screens timed out at once. It overturned the case, opened nothing and changed nothing, and handed it to the operator. |
| 2026-10-07 07:40 | Status check found `doc` halted; the other seven loops up and idle (frontier empty). |
| 2026-10-07 07:57 | ralph #238 (starved-job rule) merged and deployed to `~/ralph`. |
| 2026-10-07 07:58 | `systemctl --user restart ralph-dashboard` killed all seven running loops: they live in the unit's cgroup and its `KillMode` was the default `control-group`. All were idle at the gate, so no work was lost. The unit was recreated with `KillMode=process`. |
| 2026-10-07 07:59 | Retired the 37 starved-build flake cases under the store lock (backup: `.git/ralph/ci-health.json.bak-20261007`). 14 confirmed flakes remain. |
| 2026-10-07 08:00 | All eight loops started. The store now holds one `infra:starved-job` case (builds #3052, #3053) instead of 24 flakes; `doc` took the next real case, the media-mode conformance ratchet. |

## Root causes

1. **Loops in Orca's cgroup.** `setsid nohup` does not leave a systemd scope. Anything launched from an Orca terminal is killed when Orca restarts its daemon, which an auto-update does.
2. **A starved job was read as many flakes.** The classifier's "same tree, both colours" rule confirms a flake from a single red build plus a green build of the same tree. When one job times out across many unrelated tests because the host is starved, every one of them satisfies that rule. The store held 37 such "confirmed" flakes from four starved jobs: build #3053 (13), #3052 (11), #2653 (9) and #2570 (4). The gate would have handed them to the doctor one per run.

## Fixes

- **Dashboard as a systemd unit** (2026-10-06): `systemctl --user restart ralph-dashboard`. Never launch the dashboard from an Orca terminal. The unit must have `KillMode=process`, or restarting the dashboard kills every loop it started (2026-10-07 07:58). The unit is transient, so after a reboot it has to be recreated; #170 makes it permanent.
- **Starved-job rule** (`ci-doctor/classify.ts`, this PR): timeouts in 4+ unrelated groups (file, or describe block when jest gives no file) in one job are a single `infra:starved-job` incident and are not evidence about any test. Three is ordinary co-occurrence (library-merge build #2626) and stays evidence.
- **Store cleanup** (2026-10-07 07:59): the 37 single-starved-build flake cases retired by hand. A case whose only evidence was one of #2569's three hook timeouts was left alone: three groups is below the threshold.
- **Filed #237**: jest failures reach the store without their file path, so mobile case keys name only `describe > test` and the main-flip and cross-branch rules can never fire for them.
- **Gate spawn race** (`ralph.sh`, #243): at 09:03 (12:03Z), with a ralph test job on the self-hosted runner, loggd's `rafa` took `ETXTBSY: text file is busy, posix_spawn 'bun'` on its thirteenth idle poll and stopped — `ralph.sh` read any non-verdict gate exit as fatal. Idle, so no work was lost, but the loop sat down for ~25 minutes. A non-verdict exit is now retried (`RALPH_GATE_RETRY_MAX`, 3 asks) and recorded as `spawn-failure`; only a gate that keeps failing stops the loop. Same root cause as the starved jobs above: this host runs CI and the loops at once.

## #164 acceptance

- AC 4 (preflight with both tokens and all labels): met 2026-10-06.
- AC 5 (supervised night, no guardrail violation, retries within cap): the night ran two clean fixes and one correct hand-off, with no retries or reverts (retry counter 0, revert log empty). Closing after one clean cycle on the fixed classifier.
