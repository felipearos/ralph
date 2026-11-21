<!-- Qodo review of felipearos/software-factory PR #21 at aa5c70c0, saved 2026-11-21 before Qodo updated the comment in place. -->
<h3>Code Review by Qodo</h3>

<br/>

<img src="https://img.shields.io/badge/High-634FD1?style=flat-square" height="20px" alt="Action required">

<details>
<summary>  1.  Untriaged tickets are reported as next <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>The <b><i>ready</i></b> row treats membership in <b><i>.ready[].tickets</i></b> as proof that a loop will take the ticket,
>without checking the separate <b><i>untriaged</i></b> section. With difficulty routing enabled, the frontier
>lists tickets lacking a difficulty label in both sections, but coder loops filter them out before
>claiming.
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
>A ticket can appear in `ready` and `untriaged` simultaneously, so `ready` alone cannot establish that a coder will take it.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[104-133]
>## Recommended Fix
>Make the verdict check `untriaged` and the project's enabled routing configuration before saying PICKED NEXT; explain that the flat frontier sections can overlap.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/a3f88375-cd5d-40f8-b05b-50b54fc3795e?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/a3f88375-cd5d-40f8-b05b-50b54fc3795e)

</details>


<br/>

<details><summary><ins><strong>View medium (5)</strong></ins></summary><br/>
<img src="https://img.shields.io/badge/Medium-634FD1?style=flat-square" height="20px" alt="Remediation recommended">

<details>
<summary>  2.  Missing references escape the report <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>The reference-check pipeline sends <b><i>tracker.ts view</i></b> through <b><i>jq</i></b> without checking the tracker’s
>exit status, while suppressing its error output. When a blocker or parent number does not exist,
><b><i>jq</i></b> receives no input and exits successfully, so the <b><i>does not exist here</i></b> branch does not run.
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
>A failed reference lookup produces no missing-reference warning because the pipeline tests `jq` rather than `tracker.ts`.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[72-85]
>## Recommended Fix
>Give the skill a shell example that captures each tracker response and exit status separately, reports absent or failed lookups explicitly, and parses JSON only after a successful lookup.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/93460124-f884-4175-8ac6-0009dbc7785a?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/93460124-f884-4175-8ac6-0009dbc7785a)

</details>


<details>
<summary>  3.  Some routed tickets look unpickable <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>The difficulty-routing guidance omits <b><i>learning-fix</i></b> from the labels that exempt an otherwise
>unlabelled ticket. When routing is enabled, a ticket with that label and no configured difficulty
>label can still reach coder loops, contrary to the step-three conclusion.
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
>The skill's exemption list is narrower than the one used to route coder work.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[98-100]
>## Recommended Fix
>Add `learning-fix` to the stated exemptions, and describe the actual condition: an exempt ticket without any configured difficulty label is offered to routed loops that have a nonempty route.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/d9a4fc0b-c766-436b-ac5f-f2ddd447c020?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/d9a4fc0b-c766-436b-ac5f-f2ddd447c020)

</details>


<details>
<summary>  4.  Human-labelled work can reach a loop <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>Step three presents <b><i>ready-for-human</i></b> as meaning the ticket waits on a person, but the frontier does
>not use that label to exclude a queued candidate. If a ticket carries both <b><i>ready-for-human</i></b> and
><b><i>ready-for-agent</i></b>, it can appear in the human display and still be offered to a coder loop.
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
>The skill treats `ready-for-human` as a claim fence, although the frontier can offer a ticket that also carries `ready-for-agent`.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[91-97]
>- .claude/skills/ticket-pickup-check/SKILL.md[119-133]
>## Recommended Fix
>Tell the agent to identify both labels as a conflict and determine actual loop eligibility from the ready and claim-related frontier sections, rather than using `ready-for-human` alone as a waiting verdict.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/b696d0d6-96d1-46eb-9f6b-8673be45cf77?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/b696d0d6-96d1-46eb-9f6b-8673be45cf77)

</details>


<details>
<summary>  5.  Keyed-project dependencies go unchecked <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>The reference guidance explains <b><i>#&lt;n&gt;</i></b> parsing and bare-number lookups but gives no corresponding
>check for Linear or Jira’s keyed references. On those projects, a bare <b><i>#17</i></b> can successfully
>resolve through <b><i>tracker.ts view 17</i></b> even though the frontier ignores that text under `## Blocked
>by<b><i> or </i></b>## Parent`, leaving the ticket without the intended dependency.
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
>A successful numeric tracker lookup does not prove that the frontier recognized the reference written in a Linear or Jira ticket.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[72-85]
>## Recommended Fix
>Have the skill obtain the project's reference form through `tracker.ts ref` and check that Parent and Blocked by entries use that key for Linear or Jira; report bare `#N` entries as ignored by the frontier on those projects.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/e1f76c6d-623b-4006-8ee6-fae6d1512153?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/e1f76c6d-623b-4006-8ee6-fae6d1512153)

</details>


<details>
<summary>  6.  Oversized tickets can go unflagged <code>🐞 Bug</code></summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
>Step two describes the oversize test as counting <b><i>- [ ]</i></b> criteria against a fixed threshold of
>eight. The frontier also counts checked boxes and <b><i>*</i></b> boxes, honors a configurable threshold, and
>counts checkboxes in the whole body if the heading is absent, so those tickets can enter the
>triager’s oversize population without the check noting why.
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
>The skill's checkbox and threshold description can miss tickets the frontier classifies as oversized.
>## Fix Focus Areas
>- .claude/skills/ticket-pickup-check/SKILL.md[68-71]
>## Recommended Fix
>Describe the frontier's accepted checkbox forms, configurable criteria threshold and missing-heading fallback; distinguish these from the skill's separate advice about ticket formatting.
>```
> <code>ⓘ Copy this prompt and use it to remediate the issue with your preferred AI generation tools</code>
></details>

[Dismiss ↗](https://app.qodo.ai/findings/7f7ac3e7-128e-45fe-af37-b3aa3810f088?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/7f7ac3e7-128e-45fe-af37-b3aa3810f088)

</details>


</details>

<br/>

<!-- qodo-self-review-slot -->
<!-- https://github.com/felipearos/software-factory/commit/aa5c70c089c41a8ad3262779923fd6b1e96c854a -->

