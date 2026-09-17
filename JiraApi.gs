/**
 * Jira REST API wrapper — every direct call to Jira lives here, and
 * nothing else does (same split as NotionApi.gs for Notion). This is
 * the active Tech Council escalation target: Tech Council moved from a
 * Notion database to a Jira project (key "TC"), so escalation now
 * creates a Jira ticket instead of a Notion Draft page. See
 * NotionApi.gs's createTechCouncilDraft_ for the dormant Notion path,
 * kept on purpose in case Tech Council ever moves back to Notion.
 *
 * Authenticated with Basic Auth (JIRA_EMAIL + JIRA_API_TOKEN — an
 * Atlassian API token, not a password). See docs/SETUP.md for how to
 * create one.
 *
 * REQUEST ROUTING — confirmed the hard way (2026-09-13 test run): a
 * *scoped* Atlassian API token (the current token-creation flow's
 * default, where you pick scopes like "write:jira-work" under
 * "Classic scopes") does NOT work against the site's own domain
 * (https://<site>.atlassian.net/rest/api/3/...) — it must go through
 * the api.atlassian.com cloud gateway instead, with the site's cloud ID
 * in the path. Hitting the site domain directly with a scoped token
 * doesn't cleanly 401; Jira returns a generic "project doesn't exist or
 * you don't have permission" 400 instead, which looks exactly like a
 * real permissions problem — that's what cost a debugging round here.
 * A truly classic (unscoped) token would work directly against the
 * site domain; since scoped is what the token-creation UI defaults to
 * now, this code always routes through the gateway. See docs/SETUP.md
 * step 4a for JIRA_CLOUD_ID.
 */

// ---------------------------------------------------------------
// Low-level request wrapper
// ---------------------------------------------------------------
function jiraFetch_(cfg, method, path, bodyObj) {
  const baseUrl = 'https://api.atlassian.com/ex/jira/' + cfg.jiraCloudId;
  const options = {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.jiraEmail + ':' + cfg.jiraApiToken),
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
  };
  if (bodyObj) {
    options.payload = JSON.stringify(bodyObj);
  }

  const response = UrlFetchApp.fetch(baseUrl + path, options);
  const status = response.getResponseCode();
  const rawText = response.getContentText();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data empty, rawText still available below */ }

  if (status < 200 || status >= 300) {
    // Logged directly (not just thrown) so the raw Jira response is visible
    // in the Execution log even though the tool loop catches this error and
    // Claude's own final summary paraphrases it — see this repo's
    // "verify before pushing a speculative fix" convention.
    Logger.log('Jira API error body (' + status + ' on ' + method.toUpperCase() + ' ' + path + '): ' + rawText);
    throw new Error(
      'Jira API error (' + status + ') on ' + method.toUpperCase() + ' ' + path + ': ' + rawText
    );
  }
  return data;
}

// ---------------------------------------------------------------
// Writing
// ---------------------------------------------------------------
// The Tech Council (TC) Jira project is a plain Team-managed project —
// just Task/Workstream/Sub-task issue types and a bare To Do -> In
// Progress -> Done workflow, no dedicated Executive summary / Proposed
// solution / Alternatives considered fields like the old Notion
// template had. So all three sections go into one ADF description
// under headings, same shape as the Notion version's page body.
//
// The 🩺🧟 prefix on the summary is deliberate and load-bearing for
// recognizability — anyone scanning the TC board should be able to
// tell at a glance which tickets came from the postmortem automation
// versus a manually filed topic.
//
// Always lands in the project's default status (To Do) — this
// function never transitions the issue further. Mirrors the Notion
// version's "Draft, never Submitted" rule: escalating is automatic,
// but deciding a topic is ready to actually discuss at Tech Council is
// a human decision by design (see CLAUDE.md).
function createTechCouncilJiraTicket_(cfg, title, executiveSummary, descriptionOfProblem) {
  const description = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Executive summary' }] },
      { type: 'paragraph', content: parseMarkdownLinksToAdf_(executiveSummary) },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Description of the problem' }] },
      { type: 'paragraph', content: parseMarkdownLinksToAdf_(descriptionOfProblem) },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Proposed solution' }] },
      // intentionally blank — left for the postmortem author to fill in,
      // per the "never write the proposed solution ourselves" design rule.
      { type: 'paragraph', content: [] },
    ],
  };

  // Defensive strip: Claude sometimes adds the 🩺🧟 prefix itself despite
  // the tool description saying not to (confirmed live, 2026-09-13 —
  // TC-26 came out double-prefixed). This is the single place that
  // owns the prefix, regardless of what the model does.
  const cleanTitle = String(title).replace(/^\s*(?:🩺🧟\s*)+/u, '').trim();

  const created = jiraFetch_(cfg, 'post', '/rest/api/3/issue', {
    fields: {
      project: { key: cfg.jiraProjectKey },
      issuetype: { name: 'Task' },
      summary: '🩺🧟 ' + cleanTitle,
      description: description,
    },
  });

  return {
    key: created.key,
    url: String(cfg.jiraBaseUrl).replace(/\/+$/, '') + '/browse/' + created.key,
  };
}

// ADF ("Atlassian Document Format") equivalent of NotionApi.gs's
// parseMarkdownLinksToRichText_ — same reason: Jira's REST API doesn't
// parse Markdown either, so a literal "[text](url)" string would be
// written as literal bracket characters, not a real link. Produces ADF
// text nodes, using a "link" mark instead of Notion's rich_text `link`
// field.
function parseMarkdownLinksToAdf_(text) {
  const nodes = [];
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    nodes.push({ type: 'text', text: match[1], marks: [{ type: 'link', attrs: { href: match[2] } }] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return nodes.length > 0 ? nodes : [{ type: 'text', text: text }];
}
