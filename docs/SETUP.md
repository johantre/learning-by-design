# Setup — one-time manual steps

This automation has three moving parts: **Notion** (trigger, and the
tracker/topics data Claude reads and writes via Notion's REST API),
**this Apps Script project** (the glue), and **the Claude API** (the
actual work — autonomous comparison/classification via native
tool-calling, not MCP). Everything below marked **(manual, one-time)**
cannot be scripted away — mostly because it involves a permission-gated
Notion setup step or a secret that must never live in version control.

## 0. Prerequisites

- Node.js installed locally (for `clasp`)
- `npm install -g @google/clasp`
- A Google account with access to create Apps Script projects
- An Anthropic API key (**not** your claude.ai login — a separate API key
  with its own billing, from console.anthropic.com)
- **Workspace Owner** rights on the Acme Notion workspace — required to
  create the internal integration in step 4 (stricter than the teamspace
  "Full access" needed for the automation in step 5; check this before
  starting, it's a common place to get stuck)
- Admin/owner rights on the Acme Slack workspace, to create an
  Incoming Webhook for the destination channel

## 1. Create the Apps Script project (manual, one-time)

```
cd C:\Projects\Bitbucket\collaboration-tooling\learning-by-design
clasp login                      # opens a browser, one-time Google login
clasp create --type webapp --title "Learning by Design - Postmortem automation"
```

This generates a real `.clasp.json` with a `scriptId`. Unlike a typical
clasp project, **commit this file** — same as
`gmail-team-capacity/.clasp.json` in this repo: the scriptId isn't a
secret, and committing it is what lets the Bitbucket pipeline push
without a repo variable for it. Delete `.clasp.json.example` once the
real file is committed.

## 2. Deploy as a Web App (manual, one-time — then automatic via pipeline)

```
clasp push
clasp deploy --description "initial deploy"
```

In the Apps Script editor (`clasp open`), go to **Deploy > Manage
deployments** and copy the **Web app URL** — that's the endpoint Notion
will call. Keep this page open; you'll need the URL in step 5.

**Important — pin the deployment ID for every deploy after this one.**
`clasp deploy` without `--deploymentId` creates a brand new deployment
with a brand new `/exec` URL every time, silently orphaning whatever
URL Notion has configured. Once you have your first deployment ID (from
the command above, or `clasp deployments`), always redeploy to that
same ID:

```
clasp deploy --deploymentId <your-deployment-id> --description "..."
```

The root `bitbucket-pipelines.yml` already does this — its
`--deploymentId` is hardcoded to the deployment ID currently in use. If
you ever need to rotate to a different deployment (e.g. after
recreating the Apps Script project), update the ID in both places: the
pipeline script, and the Notion automation's webhook URL (step 5).

## 3. Set Script Properties (manual, one-time)

In the Apps Script editor: **Project Settings > Script Properties**. Add:

| Property | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `NOTION_API_TOKEN` | see step 4 below — the internal integration's static token (never expires) |
| `NOTION_API_VERSION` | optional, defaults to `2026-03-11` in `getConfig_` — only set to override |
| `POSTMORTEMS_DATABASE_ID` | the Postmortems tracker's database ID (from its URL) — see step 4 |
| `TECH_COUNCIL_DATABASE_ID` | **dormant** — the old Tech Council Topics database ID. Not read by anything active (escalation now targets Jira, see step 4a); kept only in case Tech Council ever moves back to Notion. Safe to leave unset. |
| `JIRA_BASE_URL` | the Jira site's base URL, e.g. `https://eforge.atlassian.net` — only used to build the ticket's `/browse/` URL, not for API calls — see step 4a |
| `JIRA_CLOUD_ID` | the site's Atlassian cloud ID — **required**, API calls go through `api.atlassian.com/ex/jira/<id>/...`, not the site domain directly — see step 4a for why and how to find it |
| `JIRA_EMAIL` | the email of the account owning `JIRA_API_TOKEN` below — see step 4a |
| `JIRA_API_TOKEN` | an Atlassian API token (never expires unless revoked) — see step 4a |
| `JIRA_PROJECT_KEY` | optional, defaults to `TC` in `getConfig_` — only set to override |

**Watch out when copying a database ID from its URL**: the `?v=<id>`
query parameter is *also* a 32-character ID and easy to grab by mistake
instead of the real database ID that precedes the `?` (this happened
during setup). `NotionApi.gs`'s `resolveDataSourceId_` now sanitizes
either value the same way page URLs already were, so pasting the full
URL (with or without `?v=...`) works either way — but the error you'd
otherwise get (Notion API 404, `object_not_found`) is misleading, since
Notion returns 404 rather than 403 for permission/lookup issues too.
| `SLACK_WEBHOOK_URL` | see step 6 below |
| `WEBHOOK_SHARED_SECRET` | any long random string you generate yourself — this is what stops random internet traffic from triggering the automation |
| `REPORT_URL` | the Notion URL of "Postmortem analysis: 23 postmortems against Learning by Design" |
| `TEMPLATE_URL` | the Notion URL of the v2 postmortem template |
| `TEST_POSTMORTEM_URL` | optional, only for step 7 — a real postmortem page URL to run `testRun()` against |

Auto-populated by the code on first use — don't set these manually:
`POSTMORTEMS_DATA_SOURCE_ID_RESOLVED`, `TECH_COUNCIL_DATA_SOURCE_ID_RESOLVED`
(Notion's database → data source resolution, cached after the first lookup).

These never go into git — `.clasprc.json` (your local clasp login
credentials) is gitignored for that reason. `.clasp.json` is different:
it only holds the (non-secret) scriptId, so it's committed, not
gitignored — see step 1.

## 4. Create and share a Notion internal integration (manual, one-time)

This is what replaced the old Notion MCP OAuth connector — a single
static token, no refresh, no expiry. `Code.gs` calls Notion's REST API
directly (`NotionApi.gs`) using this token.

1. Go to Notion's **Developer Portal** (My Integrations) and create a
   new **internal** integration for the Acme workspace.
   **Requires Workspace Owner** — if you don't have that, get one to do
   this one step; everything after can be delegated.
2. Capabilities: **Read content**, **Update content**, **Insert
   content**. No user information capabilities needed.
3. Copy the generated token into Script Properties as `NOTION_API_TOKEN`.
4. **Share the integration with both databases** — a brand-new
   integration has zero page access by default; any API call fails
   until you do this. On each of the **Postmortems tracker** and
   **Tech Council Topics** databases: **••• (top-right menu) >
   Connections > add your integration**. Sharing a database extends
   access to every page inside it — you don't need to share individual
   postmortem pages. This step can be done by any member with edit
   access, not just the Workspace Owner.
5. Get each database's ID from its URL (the 32-character ID right
   after the workspace domain, before any `?v=...` query string) and
   set `POSTMORTEMS_DATABASE_ID` / `TECH_COUNCIL_DATABASE_ID` in Script
   Properties.

Verify it works before writing any code changes: a quick manual
`GET https://api.notion.com/v1/databases/{database_id}` with
`Authorization: Bearer <token>` and a `Notion-Version` header should
succeed for both database IDs. If it 404s or 401s, the sharing step
(4) is usually the culprit.

## 4a. Create a Jira API token for Tech Council escalation (manual, one-time)

Tech Council moved from a Notion database to a Jira project (key `TC`,
https://eforge.atlassian.net/jira/core/projects/TC/board). Escalating a
postmortem now creates a 🩺🧟-prefixed Jira Task there (`JiraApi.gs`,
`create_tech_council_jira_ticket` tool) instead of a Notion Draft page —
the old Notion path (`createTechCouncilDraft_` in `NotionApi.gs`) is
kept but dormant, not deleted, in case Tech Council ever moves back.

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
   (logged in as whichever account should own the token — a shared/bot
   account is preferable to a personal one, so the integration doesn't
   break if that person leaves) and create an API token.
2. Set Script Properties: `JIRA_BASE_URL` (the site's base URL, e.g.
   `https://eforge.atlassian.net`), `JIRA_EMAIL` (that account's email),
   `JIRA_API_TOKEN` (the token from step 1). `JIRA_PROJECT_KEY` defaults
   to `TC` in `getConfig_` — only set it to override.
3. **Confirm that account is a Member (or Admin) of the TC project's
   own access list** — TC is a **Team-managed** project, which manages
   access per-project (Project settings → **Access**), not through a
   classic global permission scheme. Being able to create issues
   elsewhere in Jira does not carry over; the account needs to be
   explicitly added to this specific project.
4. **Find the site's cloud ID and set `JIRA_CLOUD_ID`** — required,
   see the routing note below. Either:
   - `GET https://<your-site>.atlassian.net/_edge/tenant_info` (no auth
     needed) returns `{"cloudId": "..."}`, or
   - ask Claude Code to look it up via the Atlassian/Jira integration,
     if one is connected.

**Why a cloud ID and a separate gateway, not just `JIRA_BASE_URL`?**
Confirmed the hard way (2026-09-13): the current API-token-creation
flow defaults to a *scoped* token (picking scopes like
`write:jira-work` under "Classic scopes"). A scoped token does not
work calling the site domain directly
(`https://<site>.atlassian.net/rest/api/3/...`) — it must go through
`https://api.atlassian.com/ex/jira/<cloud-id>/rest/api/3/...` instead.
Calling the site domain directly with a scoped token doesn't cleanly
401; Jira returns a generic 400 "project doesn't exist or you don't
have permission" instead — which looks exactly like a real permissions
problem and cost a debugging round before the actual cause (token
routing, not access) was found. `JiraApi.gs` always routes through the
gateway for exactly this reason — a genuinely classic (unscoped) token
would also work directly against the site domain, but scoped is what
the token-creation UI defaults to now.

Verify it works before writing any code changes: a quick manual
`GET https://api.atlassian.com/ex/jira/{JIRA_CLOUD_ID}/rest/api/3/myself`
with `Authorization: Basic base64(email:token)` should return that
account's profile (401 means the token, email, or cloud ID is wrong);
then a real `POST .../rest/api/3/issue` with a minimal Task payload
against project `TC` should succeed (400 "project doesn't exist or you
don't have permission" means step 3's project access is missing —
double-check it's genuinely on the *project's own* access list, not
just a global Jira permission).

## 5. Set up the Notion automation (manual, one-time)

Requires **Full access** on the relevant Notion teamspace (Content
editors cannot create automations — see the earlier blocker).

**Notion's "Send webhook" action has no free-form JSON body editor** —
confirmed against the actual UI (2026), contradicting what an earlier
version of this doc assumed. It only offers:
- **URL** — the Web app URL from step 2
- **Aangepaste koptekst toevoegen / Add custom header** — key/value pairs
- **Content** — a checklist of *database page properties* to include
  (Owner, Status, Tags, ...) — Notion assembles its own JSON shape from
  these, you don't control the structure

**Don't use the custom header for the secret.** Notion's UI can add
one fine (Key/Value fields right under the URL) — the limitation isn't
on Notion's sending side. It's that `doPost(e)` on the *receiving* side
has no way to read custom HTTP request headers at all, confirmed
against Google's own Apps Script docs (Google has stated this will
never be supported, for security reasons). The only fields `doPost(e)`
can actually read are `e.parameter`/`e.parameters` (URL query string)
and `e.postData.contents` (the body). Since the body's shape is
Notion's own, not ours to define, **the secret must go in the URL as a
query parameter** instead — leave the custom header field empty.

**Confirmed payload shape** — real example, captured via a webhook.site
inspection on a throwaway test database (2026-08-08; IDs are that test
database's, not the real tracker's — don't repeat this test against the
real tracker, this is settled now). Notion wraps the full page object
(same shape as `GET /v1/pages/{id}`) under `data`, alongside `source`
metadata about the automation itself:
```json
{
  "source": {
    "type": "automation",
    "automation_id": "3b637352-fd32-804a-be29-004def847f4d",
    "action_id": "3b637352-fd32-801a-b309-005ac3ad46e9",
    "event_id": "3aa1b5c3-304e-442c-a99c-ea53302c9ec0",
    "attempt": 1
  },
  "data": {
    "object": "page",
    "id": "3b637352-fd32-800d-b153-e7703ce2cc12",
    "created_time": "2026-08-08T13:47:00.000Z",
    "last_edited_time": "2026-08-08T13:48:00.000Z",
    "created_by": { "object": "user", "id": "3a3d872b-594c-8168-a005-0002829a2928" },
    "last_edited_by": { "object": "user", "id": "3a3d872b-594c-8168-a005-0002829a2928" },
    "cover": null,
    "icon": null,
    "parent": {
      "type": "data_source_id",
      "data_source_id": "3b637352-fd32-805b-a52b-000bbcc5e13b",
      "database_id": "3b637352-fd32-80e5-850c-f07438e072a7"
    },
    "in_trash": false,
    "is_archived": false,
    "is_locked": false,
    "properties": {
      "Name": {
        "id": "title",
        "type": "title",
        "title": [
          {
            "type": "text",
            "text": { "content": "New page to test webhook", "link": null },
            "annotations": { "bold": false, "italic": false, "strikethrough": false, "underline": false, "code": false, "color": "default" },
            "plain_text": "New page to test webhook",
            "href": null
          }
        ]
      },
      "Ready for Review": { "id": "T%5E%5BW", "type": "checkbox", "checkbox": true }
    },
    "url": "https://app.notion.com/p/New-page-to-test-webhook-3b637352fd32800db153e7703ce2cc12",
    "public_url": null,
    "request_id": "8a4ad7e5-1dfe-49d8-bc55-6f7f205cb7c2"
  }
}
```
`Code.gs`'s `doPost()` reads the page ID from **`data.id`** — everything
else here (properties, parent, timestamps) is available if ever needed,
but not currently used; `runPostmortemReview_` re-fetches the page fresh
via `NotionApi.gs` anyway, so this webhook payload only has to identify
*which* page, not carry its content.

On the **Postmortems tracker** database:
1. Click the ⚡ automations icon > **New automation**.
2. Trigger: **Page edited** → property **"Ready for meta-review"** →
   condition **is checked**.
3. Action: **Send webhook**.
4. URL: the Web app URL from step 2 (pinned deployment — see "Ongoing
   deploys" below), **with `?secret=<WEBHOOK_SHARED_SECRET value>`
   appended** — e.g. `https://script.google.com/macros/s/<id>/exec?secret=...`.
   This arrives in `doPost(e)` as `e.parameter.secret`.
5. Content: doesn't actually matter for `doPost()` to function — `data.id`
   is always present regardless of what's checked here. Check "Ready for
   meta-review" anyway, it's a harmless sanity check when reading raw
   payloads later, but not required.

## 6. Create a Slack Incoming Webhook (manual, one-time)

1. In Slack: **Apps > Incoming Webhooks** (or via api.slack.com/apps if
   your workspace doesn't have the classic Incoming Webhooks app
   enabled — in that case create a minimal Slack app with the
   `incoming-webhook` scope).
2. Add it to whichever channel should receive these summaries (pick a
   real channel for production use, not a personal test channel).
3. Copy the webhook URL into the `SLACK_WEBHOOK_URL` Script Property.

Incoming Webhook URLs are bound to one channel at creation — to change
the channel later, create a new webhook (there's no "edit channel"
option) and update `SLACK_WEBHOOK_URL` to the new URL.

## 7. Test before going live

In the Apps Script editor, set a `TEST_POSTMORTEM_URL` Script Property
to a real postmortem page URL (don't paste it into `testRun()` in
`Code.gs` itself — a value hardcoded there gets wiped out by the next
`clasp push` from git). Then run `testRun()` manually (Run > testRun).
Check:
- Apps Script execution log for errors
- The postmortem page in Notion for the written-back Failure class /
  Related incidents
- If this was the 3rd+ postmortem in its failure class: the TC Jira
  board for a new 🩺🧟-prefixed Task in "To Do"
- The Slack channel configured in `SLACK_WEBHOOK_URL` for the summary message

Only once this works end-to-end should you check "Ready for meta-review"
on a real postmortem and let the Notion automation trigger it for real.

**Migrating from the old MCP-based setup?** Add the new Script
Properties (step 3) *alongside* the still-present `NOTION_MCP_*` ones
first, verify `testRun()` end-to-end, and only then delete the old
`NOTION_MCP_URL` / `NOTION_MCP_TOKEN_ENDPOINT` / `NOTION_MCP_CLIENT_ID` /
`NOTION_MCP_CLIENT_SECRET` / `NOTION_MCP_TOKEN` / `NOTION_MCP_REFRESH_TOKEN`
/ `NOTION_MCP_TOKEN_EXPIRES_AT` / `NOTION_MCP_TOKEN_ENDPOINT_DISCOVERED`
Script Properties — nothing in the code reads them anymore, they're just
clutter (and an old, still-valid-until-it-expires credential) once
you've cut over.

## Ongoing deploys

Once `.clasp.json` is committed (step 1) and the Bitbucket repository
variable `CLASPRC_JSON_LEARNING_BY_DESIGN` is set (Repository settings
> Repository variables — base64-encode the contents of your
`~/.clasprc.json` after `clasp login`, and mark it **Secured**), every
push to `main` that touches `learning-by-design/**` redeploys
automatically via the root-level `bitbucket-pipelines.yml` (this
project has no `bitbucket-pipelines.yml` of its own — Bitbucket only
reads one at the repo root, same as `gmail-team-capacity`). Script
Properties (secrets) are untouched by this pipeline on purpose —
they're not code, and shouldn't live in git.

If `CLASPRC_JSON_LEARNING_BY_DESIGN` is missing or not valid base64 of
a full `.clasprc.json`, the pipeline step fails fast — before even
running `npm install` — with an explicit message instead of clasp's
cryptic "Unexpected end of JSON input".

## Remaining known limitations

- **Creating** the internal integration in step 4 requires a Workspace
  Owner — that one step can't be delegated further down, everything
  after it can be. There is no recurring manual step beyond this: the
  integration token is static and doesn't expire, unlike the old MCP
  OAuth connector this replaced.
- `WEBHOOK_SHARED_SECRET` is a simple shared-secret check via a URL
  query parameter, not a signed HMAC — and unavoidably so, since Apps
  Script's `doPost(e)` cannot read custom HTTP headers at all (confirmed
  against Google's own docs) and Notion's webhook action has no
  free-form body to put a signed field in either. Consider a signed
  request if Notion's webhook action ever supports it (verify in
  current Notion docs).
- ~~`doPost()` doesn't match Notion's real webhook body~~ — resolved
  2026-08-08, see step 5 for the confirmed shape (`data.id`).
