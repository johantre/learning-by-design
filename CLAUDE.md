# Project memory — Learning by Design postmortem automation

See @README.md for the architecture and @docs/SETUP.md for setup steps.
This file is the "why", not the "how" — read it before making changes.

## Where this comes from

Acme has a `Postmortems tracker` in Notion with 23 postmortems going
back to 2024. An analysis of all 23 found five clusters of repeated
incidents (same root cause, months apart) where no postmortem ever
linked to the earlier one — the knowledge existed but wasn't
retrievable. Full analysis, with the five clusters and metaphor
examples per cluster, lives in Notion: **"Postmortem analysis: 23
postmortems against Learning by Design"** (ask the project owner for
the current link if not in Script Properties `REPORT_URL`).

This is read against Acme' **Learning by Design** knowledge base:
https://johantre.github.io/ai-value-flow-lab/learning-by-design/
— grounded in Snowden's distinction between tacit and explicit
knowledge (forcing a debrief straight into a fixed template loses the
tacit signal) and Nonaka's metaphor → analogy → model principle
(a debrief should open with an image, not a form).

## What exists in Notion already (this repo automates around it, doesn't replace it)

- **Postmortem template v2** — same classic sections as the original
  template (Summary, Impact, Detection, Resolution, Root cause,
  Timeline, What went well, Actions, Lessons learned — nothing
  removed), plus: a metaphor-opening question before, and a
  "signal-informed layer" after (pre-narrative, story elicitation,
  a 4-scale self-assessment, related incidents). URL in Script
  Properties `TEMPLATE_URL`.
- **Postmortems tracker schema** was extended with three properties
  this automation writes to: `Ready for meta-review` (checkbox,
  the trigger — deliberately NOT the existing `Status` field, which
  the analysis found to be unreliable), `Failure class` (multi-select,
  pre-seeded with the five known clusters + "other"), `Related
  incidents` (self-relation; its auto-generated mirror property was
  renamed to `Related incidents (mirror)` for clarity).
- **Tech Council Topics list** — a separate database with its own
  template (Executive summary / Description of the problem / Proposed
  solution / Alternatives considered / Discussion & Feedback) and
  Status flow Draft → Submitted → In progress → Done. **Dormant as of
  the Jira move below** — the old Notion page was deleted; kept here as
  a description of the design this replaced, and because
  `createTechCouncilDraft_` (`NotionApi.gs`) still assumes this shape if
  it's ever wired back in.

## What exists in Jira (Tech Council escalation target)

- **Tech Council project, key `TC`**
  (https://eforge.atlassian.net/jira/core/projects/TC/board) — a plain
  Team-managed project (Task / Workstream / Sub-task issue types, bare
  To Do → In Progress → Done workflow), replacing the Notion database
  above. It has no dedicated Executive summary / Proposed solution /
  Alternatives considered fields, so `createTechCouncilJiraTicket_`
  (`JiraApi.gs`) puts all three under headings in one ADF description,
  mirroring the old Notion page body's structure.
- **Jira API calls go through `api.atlassian.com/ex/jira/<cloud-id>`,
  never the site domain directly** — confirmed the hard way
  (2026-09-13): the current Atlassian token-creation flow defaults to a
  *scoped* API token, which doesn't work against
  `https://<site>.atlassian.net/rest/api/3/...` directly. It fails with
  a generic 400 "project doesn't exist or you don't have permission"
  instead of a clean 401, which is indistinguishable from an actual
  project-access problem — a real access issue (TC being a
  Team-managed project needing the caller on its own access list, not
  just a global Jira permission) was fixed first and didn't help,
  before the routing itself turned out to be the cause. See
  `docs/SETUP.md` step 4a before "fixing" this back to the site domain.

## Deliberate design decisions — don't "fix" these without re-reading why

- **The automation never writes the metaphor.** It recognizes when a
  fresh metaphor resembles earlier ones (that's the whole point — see
  "Related incidents" above) but never generates or suggests one
  proactively. Nonaka's point is that the metaphor has to be the
  author's own, unguided image; an AI-supplied one would anchor their
  account instead of eliciting it.
- **The automation never touches the postmortem's `Status` property.**
  The 23-postmortem analysis found two postmortems stuck on
  "In progress" with an empty template, and two others sitting on
  "To do" despite being complete and high quality — the field is
  known to be unreliable. Layering more automation on top of an
  already-unreliable signal was judged to make things worse, not
  better.
- **Escalation only ever creates a Jira ticket in its default "To Do"
  status**, never moves it further (this was "only ever creates a
  Draft, never Submitted" back when Tech Council lived in Notion —
  same principle, new home). Submitting a topic for actual discussion
  at Tech Council is a human decision by design.
- **Escalation tickets are always prefixed `🩺🧟` on the summary** —
  deliberate and load-bearing, not decorative: it's what lets anyone
  scanning the TC board tell at a glance which tickets came from the
  postmortem automation versus a manually filed topic.
- **The Notion escalation path (`createTechCouncilDraft_`,
  `NotionApi.gs`) is dormant, not deleted.** Tech Council moved to
  Jira and the old Notion page was removed, but the function is kept
  in case Tech Council ever moves back — don't delete it as "dead
  code" without checking this note first.
- **Threshold for escalation is 3+ postmortems in the same Failure
  class** — chosen because all five discovered clusters had 2+
  incidents before anyone noticed the pattern; 3 is deliberately a
  bit conservative rather than fully proven.
- **Terminology:** the KB and internal discussion used "SenseMaker"
  (Cognitive Edge's named methodology) for the 4-scale positioning
  exercise; anything user-facing (Notion template, Slack messages)
  uses the neutral term "self-assessment" instead, to avoid presenting
  a third-party commercial product name as if it were Acme' own
  process, without explanation.
- **Slack/Claude Tag (ambient mode) was the first design**, then
  dropped in favor of this Apps Script + direct Claude API approach —
  not because it doesn't work, but because it requires Notion
  "Full access" permissions that weren't available at the time, and
  because a single autonomous API call (Claude comparing/classifying
  via native tool-calling against this repo's own Notion REST wrapper,
  same judgment it would apply in a chat) turned out simpler than
  routing through Slack ambient-mode detection. If Notion permissions
  change, ambient mode remains a valid simpler alternative worth
  reconsidering.
- **Notion access is a static internal integration token via plain REST
  calls (`NotionApi.gs`), not Notion's hosted MCP connector.** The MCP
  connector was the original design, but Notion's hosted MCP OAuth
  server does not reliably issue a `refresh_token`, forcing a recurring
  manual re-auth every few days — a confirmed, widely-reported,
  externally-unfixed Notion limitation, not something wrong with this
  code. Switching to a static token + Anthropic's native tool-calling
  removes that entirely, with no new hosting required (Apps Script is
  already always-on). Don't reintroduce the MCP connector for this without
  re-reading this note.

## Working on this repo

Claude Code doesn't need Notion or Jira access to work on this
codebase — it only authors
`Code.gs`/`NotionApi.gs`/`JiraApi.gs`/`ClaudeToolLoop.gs`/`Slack.gs`,
the pipeline, and docs. The deployed Apps Script is what talks to
Notion and Jira at runtime (via `NotionApi.gs`'s and `JiraApi.gs`'s
REST calls), not Claude Code while editing. If "Notion MCP" comes up in
a Claude Code session, that's Claude Code's own optional dev-time
connector for testing against the live tracker directly — unrelated to
this app's runtime path, which doesn't use MCP at all (see the
"Deliberate design decisions" note above on why). Likewise, if
Atlassian/Jira MCP tools are available in a Claude Code session, those
are for inspecting the live TC project directly (e.g. checking issue
types, or looking at existing tickets) — not part of this app's runtime
path either, which only ever uses `JiraApi.gs`'s plain REST calls.

## Conventions for this repo

- All user-facing text (Notion pages, Slack messages, code comments)
  is in **English** — the working conversation that produced this was
  in Dutch, but Acme' existing tracker/KB content is English, so
  everything shipped here follows that.
- Secrets never enter git — Script Properties only (see
  `docs/SETUP.md`). `.clasprc.json` is gitignored; `.clasp.json` is
  committed on purpose (scriptId isn't a secret — see
  `gmail-team-capacity/.clasp.json` for the same pattern).
- This repo has no `bitbucket-pipelines.yml` of its own — Bitbucket
  only reads one at the repo root, so the deploy step lives there,
  gated by `includePaths: learning-by-design/**` (same convention as
  `gmail-team-capacity`'s step).
- `Code.gs` is a **thin orchestrator only** — `doGet`/`doPost`/`testRun`/
  `getConfig_`/`runPostmortemReview_`. Everything else is deliberately
  split out by responsibility: `NotionApi.gs` (every direct Notion REST
  call), `JiraApi.gs` (every direct Jira REST call — Tech Council
  escalation), `ClaudeToolLoop.gs` (tool schemas + the native tool-use
  loop), `Slack.gs` (posting to Slack). This was a real split done
  specifically when the Notion MCP connector was replaced with direct
  REST calls + tool-calling (see "Deliberate design decisions" above) —
  the surface area genuinely justified it. Don't merge these back into
  one file, and don't add new files without a similarly clear single
  responsibility.
  **Also**: the Claude system prompt itself lives in `PromptTemplate.html`,
  split out of `Code.gs` so it can be edited as plain text with no JS
  syntax around it — see "Tuning the prompt" in `README.md`. Don't fold
  it back into `Code.gs` either.
