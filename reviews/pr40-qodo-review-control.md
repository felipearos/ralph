<!-- Qodo review comment 7085794133 on felipearos/software-factory PR #40, head 5b3fdd1f, as it read at 2026-11-22T21:32:21Z (control). -->
<h3>Code Review by Qodo</h3>

<br/>

<details><summary><ins><strong>View medium (1)</strong></ins></summary><br/>
<img src="https://img.shields.io/badge/Medium-634FD1?style=flat-square" height="20px" alt="Remediation recommended">

<details>
<summary>  1.  The dashboard hides dropped blockers <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
><b><i>githubRefs</i></b> discards a foreign repository reference and records it only with <b><i>console.error</i></b>,
>without retaining it for the frontier report. When an issue cites a foreign blocker or parent, the
>JSON backlog contains neither that edge nor an explanation for its removal, and the dashboard reads
>that JSON rather than stderr.
></pre>
></details>

> <details>
><summary>Agent prompt</summary>
><br/>
>
>```
>The issue below was found during a code review. Follow the provided context and guidance below and implement a solution
>
>## Issue description
>Foreign blockers and parents are dropped with only a stderr warning, so the JSON backlog cannot explain that readiness decision to the dashboard.
>
>## Fix Focus Areas
>- frontier/next-tasks.ts[624-635]
>- frontier/next-tasks.ts[1750-1772]
>- dashboard/adapter.ts[743-878]
>- dashboard/contracts.ts[900-940]
>
>## Recommended Fix
>Retain ignored references with their source ticket while building the graph, expose them in the dry-run JSON report, and carry that information through the dashboard adapter and view. Keep foreign references out of local blocker and parent edges.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/4c02e629-d564-4475-9cd6-f308292a3b97?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/4c02e629-d564-4475-9cd6-f308292a3b97)

</details>


</details>
<br/>

<details><summary><ins><strong>View low (1)</strong></ins></summary><br/>
<img src="https://img.shields.io/badge/Low-634FD1?style=flat-square" height="20px" alt="Informational">

<details>
<summary>  2.  Triage&#x27;s new path lacks command coverage <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>The added test calls <b><i>parseProseBlockers</i></b> and <b><i>parseParent</i></b> directly but never runs <b><i>triage-apply</i></b>
>with a foreign repository reference. That leaves the new repository initialization in the triage
>command untested, even though this command reads and simulates its own census without calling
><b><i>frontierTracker()</i></b>.
></pre>
></details>

> <details>
><summary>Agent prompt</summary>
><br/>
>
>```
>The issue below was found during a code review. Follow the provided context and guidance below and implement a solution
>
>## Issue description
>Helper tests do not exercise the repository-setting branch of the triage command, so a future mismatch between its simulation and the frontier could escape command-level tests.
>
>## Fix Focus Areas
>- triage-apply.ts[253-269]
>- triage-apply.test.ts[75-112]
>- frontier/next-tasks.test.ts[199-255]
>
>## Recommended Fix
>Use the existing fake-census CLI test harness to run triage-apply with a cross-repository blocker or parent and assert that its validation or simulation treats the reference as foreign, consistently with the frontier.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/844360a3-7db1-47a3-8150-769b98c170ef?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/844360a3-7db1-47a3-8150-769b98c170ef)

</details>


</details>

<br/>

<!-- qodo-self-review-slot -->
<!-- https://github.com/felipearos/software-factory/commit/5b3fdd1f6d79269f08fe4bd3942b5d19f414d242 -->

