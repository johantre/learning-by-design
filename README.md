# Learning by Design — Postmortem meta-review automation

Triggers a Claude-driven meta-review whenever a postmortem in the Acme
Notion workspace is marked "Ready for meta-review". Claude reads the
page and compares it against the rest of the Postmortems tracker
autonomously, grounded in the
[Learning by Design](https://johantre.github.io/ai-value-flow-lab/learning-by-design/)
knowledge base — not a generic keyword match.

## Architecture

```
Notion (checkbox "Ready for meta-review" checked)
        │  automation: Send webhook — URL has ?secret=... (Apps Script's
        │  doPost(e) can't read custom headers); body is Notion's own
        │  envelope, page ID at body.data.id (confirmed via webhook.site,
        │  see docs/SETUP.md step 5)
        ▼
Google Apps Script Web App  (this repo)
        │
        │  Code.gs pre-fetches the target postmortem + a lightweight
        │  tracker dump via Notion's REST API (NotionApi.gs, static
        │  integration token — no OAuth)
        ▼
Claude API call, native tool-calling (ClaudeToolLoop.gs) — autonomously:
   - compares the postmortem against the tracker dump
   - optionally reads a specific prior postmortem in full depth
     (read_notion_page tool)
   - writes back "Failure class" + "Related incidents"
     (update_postmortem_properties tool → NotionApi.gs → Notion REST API)
   - if 3rd+ occurrence of the same failure class: creates a 🩺🧟-prefixed
     Jira ticket in the Tech Council project, TC
     (create_tech_council_jira_ticket tool → JiraApi.gs → Jira REST API)
   - returns a text summary
        │
        ▼
Apps Script posts the summary to Slack, via Incoming Webhook (Slack.gs)
```

Every Notion read/write is a plain REST API call authenticated with a
static internal integration token (see `docs/SETUP.md` step 4); every
Jira write is a plain REST API call authenticated with an Atlassian API
token (see `docs/SETUP.md` step 4a) — no MCP server, no OAuth, no
refresh tokens anywhere. Claude keeps its autonomous judgment via
Anthropic's native tool-calling instead.

## Example Slack summary

What a good output looks like — one opening sentence, a nested bullet list
for the causal chain/cascade, short separate bullets for the facts, and an
"Open mitigations" group when relevant, all in Slack mrkdwn (`*bold*`,
no headers/tables):

```
Request threadpool overload is the kind of postmortem that makes you
wince a little — the failure isn't a mystery, it's a machine you've seen
run before.
- A DB hiccup (lost connectivity, or idle in transaction sessions
  piling up)
  - drains pgbouncer's server pool
  - which stalls HikariCP
  - which parks all 200 Jetty threads
  - which means /livez never gets answered
  - which means Kubernetes kills the pod, and the cycle repeats on a
    neighbour
- This is the *4th* postmortem in the db-connectivity-unresponsive
  failure class
- Tagged accordingly and linked to the 3 prior incidents
- Escalated: 🩺🧟 Jira ticket created in Tech Council (TC-142), with the
  "Proposed solution" left blank for the author to fill in

Mitigations:
✓ Circuit breaker deployed on the pgbouncer connection pool
☐ Gateway-level surge protection for /livez
```

(shown as a plain code block on purpose — this is *literally* what gets
posted to Slack, `*bold*` and all; a Markdown blockquote would risk
rendering the nested bullets flattened, misrepresenting the real output)

When tuning the prompt (in `PromptTemplate.html`, see below), compare
against this shape before doing a full `clasp push` + `testRun()`
round-trip.

## Tuning the prompt

The actual text sent to Claude lives in
[`PromptTemplate.html`](PromptTemplate.html) — a plain-text file (not
real HTML; `.html` is just the file type Apps Script/clasp can push and
read as-is), editable directly in the Apps Script editor with no code
syntax involved. `Code.gs`'s `buildSystemPrompt_` only fills in the
`{{KB_URL}}` and `{{REFERENCE_LINES}}` placeholders — see the comment
at the top of `PromptTemplate.html` for what those are.

Changing the prompt still requires the same deploy step as any other
code change (`clasp push` updates what the editor's `Run > testRun`
uses; the pinned deployment used by the real Notion webhook needs
`clasp deploy --deploymentId ...` — see `docs/SETUP.md`, "Ongoing
deploys"). This intentionally stops short of a live-editable Google Doc
or similar: keeping the prompt in git means prompt changes go through
the same review/history as code changes, which matters for something
that directly controls what gets written back into Notion.

## What stays manual, by design

- The postmortem's **Status** property — the tracker showed this field
  is unreliable, so no automation touches it.
- Writing the metaphor itself — Claude only recognizes patterns across
  existing metaphors, it never invents one for the author.
- Submitting an escalated Tech Council topic for actual discussion —
  Claude only creates the 🩺🧟 Jira ticket, which always lands in "To Do".

## Setup

See [`docs/SETUP.md`](docs/SETUP.md) for the full one-time setup
(Apps Script deployment, Notion internal integration, Notion automation
configuration, Slack webhook). None of this can be fully scripted —
it involves permission-gated Notion setup steps and secrets that must
never enter version control.

## Repo layout

```
Code.gs               — thin orchestrator: doGet/doPost/testRun/getConfig_,
                        and runPostmortemReview_ (the pre-fetch + tool loop)
NotionApi.gs          — every direct Notion REST API call, nothing else
JiraApi.gs            — every direct Jira REST API call, nothing else
                        (Tech Council escalation — createTechCouncilDraft_
                        in NotionApi.gs is the dormant Notion-era
                        equivalent, kept in case Tech Council moves back)
ClaudeToolLoop.gs     — the Claude tool schemas + native tool-use loop
Slack.gs              — posting to Slack
PromptTemplate.html   — the actual Claude system prompt, as plain text —
                        edit this to change what Claude does/how it writes,
                        not Code.gs (see "Tuning the prompt" below)
appsscript.json       — Apps Script manifest
.clasp.json           — links this folder to the Apps Script project
                        (committed once it exists, like gmail-team-capacity/.clasp.json —
                        the scriptId isn't a secret)
.clasp.json.example   — template, until the real .clasp.json exists (see docs/SETUP.md)
docs/
  SETUP.md            — one-time manual setup steps
```

Deployment is defined centrally in the repo-root
[`bitbucket-pipelines.yml`](../bitbucket-pipelines.yml) — Bitbucket only
reads a pipelines file at the repo root, so there is no
`bitbucket-pipelines.yml` inside this folder. The root pipeline's
"Deploy learning-by-design" step is gated to only run when files under
`learning-by-design/**` change, same pattern as `gmail-team-capacity`.

## Deploying changes

```
clasp login                          # once per machine
clasp push
```

Or just push to `main` — the Bitbucket pipeline does the same via the
`CLASPRC_JSON_LEARNING_BY_DESIGN` repository variable (see
`docs/SETUP.md`).

## Related Notion pages

- Postmortem template v2
- Postmortem analysis report (23 postmortems, 5 clusters, metaphor examples)
- ~~Tech Council Topics list~~ — dormant; Tech Council now lives in Jira
  (project TC), see "Related Jira project" below

(URLs are kept in Script Properties, not hardcoded here — see `REPORT_URL`
/ `TEMPLATE_URL` in `docs/SETUP.md`.)

## Related Jira project

- Tech Council (key `TC`) — escalated postmortems land here as 🩺🧟-prefixed
  Task tickets in "To Do" (`create_tech_council_jira_ticket` tool, see
  `JiraApi.gs`)
