/**
 * Learning by Design — Postmortem meta-review automation
 * ---------------------------------------------------------
 * Receives a webhook from Notion (fired when "Ready for meta-review"
 * is checked on a postmortem page), calls the Claude API with native
 * tool-calling so Claude can autonomously compare it against the
 * tracker and decide what to write back, and posts Claude's findings
 * to Slack. Every tool Claude can call is implemented in this codebase
 * against a plain REST API with a static token — Notion reads/writes in
 * NotionApi.gs, Tech Council escalation (Jira) in JiraApi.gs — no MCP,
 * no OAuth, no refresh tokens.
 *
 * Claude is instructed to work within the Learning by Design
 * framework (metaphor → analogy → model, Snowden's tacit/explicit
 * knowledge distinction, the self-assessment scales) rather than
 * doing a generic keyword comparison.
 *
 * This file is a thin orchestrator on purpose — the actual Notion
 * calls live in NotionApi.gs, Jira calls in JiraApi.gs, the Claude
 * tool-use loop in ClaudeToolLoop.gs, and Slack posting in Slack.gs.
 *
 * All secrets live in Script Properties — never hardcode them here.
 * See docs/SETUP.md for the one-time setup this depends on.
 */

// ---------------------------------------------------------------
// Configuration (read from Script Properties — see docs/SETUP.md)
// ---------------------------------------------------------------
function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    anthropicApiKey: props.getProperty('ANTHROPIC_API_KEY'),
    claudeModel: props.getProperty('CLAUDE_MODEL') || 'claude-sonnet-4-6', // verify current model id in docs.claude.com before relying on this
    notionApiToken: props.getProperty('NOTION_API_TOKEN'),
    notionApiVersion: props.getProperty('NOTION_API_VERSION') || '2026-03-11',
    postmortemsDatabaseId: props.getProperty('POSTMORTEMS_DATABASE_ID'),
    // Dormant: Tech Council moved from Notion to Jira (see jiraProjectKey
    // below / JiraApi.gs). Kept so createTechCouncilDraft_ in NotionApi.gs
    // still works if Tech Council ever moves back to Notion.
    techCouncilDatabaseId: props.getProperty('TECH_COUNCIL_DATABASE_ID'),
    jiraBaseUrl: props.getProperty('JIRA_BASE_URL'), // e.g. https://eforge.atlassian.net — only used to build browse URLs, not for API calls (see JiraApi.gs)
    jiraCloudId: props.getProperty('JIRA_CLOUD_ID'), // required — API calls go through api.atlassian.com/ex/jira/<id>, see JiraApi.gs
    jiraEmail: props.getProperty('JIRA_EMAIL'), // account owning the JIRA_API_TOKEN below
    jiraApiToken: props.getProperty('JIRA_API_TOKEN'),
    jiraProjectKey: props.getProperty('JIRA_PROJECT_KEY') || 'TC',
    slackWebhookUrl: props.getProperty('SLACK_WEBHOOK_URL'),
    webhookSharedSecret: props.getProperty('WEBHOOK_SHARED_SECRET'),
    kbUrl: props.getProperty('KB_URL') || 'https://johantre.github.io/ai-value-flow-lab/learning-by-design/',
    reportUrl: props.getProperty('REPORT_URL') || '', // Notion URL of "Postmortem analysis" report — set after first deploy
    templateUrl: props.getProperty('TEMPLATE_URL') || '', // Notion URL of the v2 template
  };
}

// ---------------------------------------------------------------
// Entry point — Notion calls this via its "Send webhook" automation
// ---------------------------------------------------------------
function doPost(e) {
  const cfg = getConfig_();

  // Shared-secret check via a URL query parameter (?secret=...), NOT a
  // header or the body — Apps Script's doPost(e) has no documented way
  // to read custom HTTP request headers (confirmed against Google's own
  // Web Apps docs), and Notion's "Send webhook" action has no free-form
  // body editor to put a custom field in either. This Web App URL is
  // publicly reachable; this check is the only thing standing between
  // it and the open internet.
  if (!cfg.webhookSharedSecret || (e.parameter && e.parameter.secret) !== cfg.webhookSharedSecret) {
    return jsonResponse_({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'Invalid JSON payload' }, 400);
  }

  // Confirmed via a webhook.site inspection (2026-08-08): Notion's "Send
  // webhook" automation action wraps the full page object (same shape as
  // GET /v1/pages/{id}) under `data`, alongside `source` metadata about
  // the automation itself. `data.id` is the page ID — no URL parsing
  // needed, though extractNotionPageId_ would accept `data.url` too.
  const pageId = body.data && body.data.id;
  if (!pageId) {
    return jsonResponse_({ ok: false, error: 'Missing data.id in webhook payload' }, 400);
  }

  try {
    const summary = runPostmortemReview_(pageId, cfg);
    postToSlack_(summary, cfg);
    return jsonResponse_({ ok: true });
  } catch (err) {
    // Still notify Slack on failure, so a silent break doesn't go unnoticed.
    try {
      postToSlack_(
        `⚠️ Postmortem meta-review failed for ${pageId}\n\`\`\`${err.message}\`\`\``,
        cfg
      );
    } catch (slackErr) {
      // swallow — we still want to return an error response below
    }
    return jsonResponse_({ ok: false, error: err.message }, 500);
  }
}

// Simple health check — visit the deployed URL in a browser to confirm it's live.
function doGet(e) {
  return ContentService.createTextOutput('Learning by Design automation is running.');
}

// ---------------------------------------------------------------
// Core: deterministic pre-fetch, then a native-tool-calling Claude loop
// ---------------------------------------------------------------
// The target postmortem and a lightweight tracker dump are always needed,
// every run — no reason to make those two reads "agentic." Only the
// judgment calls (reading a prior postmortem in more depth, and the two
// writes) are exposed to Claude as tools — see ClaudeToolLoop.gs.
function runPostmortemReview_(pageUrl, cfg) {
  const systemPrompt = buildSystemPrompt_(cfg);
  const targetPage = getPageWithBody_(cfg, pageUrl);

  // Fail fast and clearly if the target isn't actually a Postmortems tracker
  // row — e.g. the tracker's own index page, or some other stray Notion page
  // (this has happened: a wrong TEST_POSTMORTEM_URL produced a confusing,
  // half-wrong result instead of an obvious error). "Ready for meta-review"
  // only exists on genuine tracker entries, so its presence is a reliable check.
  if (!('Ready for meta-review' in (targetPage.properties || {}))) {
    throw new Error(
      'Target page ' + targetPage.url + ' does not appear to be a Postmortems ' +
      'tracker entry (missing the "Ready for meta-review" property) — check ' +
      'TEST_POSTMORTEM_URL or the incoming webhook\'s page reference.'
    );
  }

  const trackerDump = dumpTrackerForComparison_(cfg, targetPage.id);

  const userMessage =
    'New postmortem ready for meta-review.\n\n' +
    'Target postmortem (the one to review):\n' +
    JSON.stringify({
      id: targetPage.id,
      url: targetPage.url,
      properties: targetPage.properties,
      bodyText: targetPage.bodyText,
    }) +
    '\n\n' +
    'Rest of the Postmortems tracker, for comparison (title/failure class/' +
    'related incidents/url only — use the read_notion_page tool if you ' +
    'need to read one of these in full depth):\n' +
    JSON.stringify(trackerDump) +
    '\n\n' +
    'Decide the Failure class and Related incidents for the target ' +
    'postmortem and write them back with the update_postmortem_properties ' +
    'tool. If this is the 3rd or later occurrence of the same failure ' +
    'class, escalate with the create_tech_council_jira_ticket tool. Then ' +
    'write a short, engaging summary of what you found and what you wrote ' +
    'back — a few sentences someone would actually want to read in Slack, ' +
    'not a structured report.';

  return runToolLoop_(systemPrompt, userMessage, cfg, targetPage.id);
}

// The prompt text itself lives in PromptTemplate.html, not here — edit
// that file directly (it's plain text, no code syntax) rather than this
// function. This only fills in the handful of parts that genuinely need
// to be computed (optional reference links, config values).
function buildSystemPrompt_(cfg) {
  const template = HtmlService.createHtmlOutputFromFile('PromptTemplate').getContent();
  const promptBody = template.split('\n---\n')[1];
  if (!promptBody) {
    throw new Error(
      'PromptTemplate.html is missing its "---" marker separating the ' +
      'editor instructions from the actual prompt text.'
    );
  }

  const referenceLines = [
    cfg.reportUrl ? '- Postmortem analysis report (clusters + metaphor examples): ' + cfg.reportUrl : '',
    cfg.templateUrl ? '- Postmortem template v2: ' + cfg.templateUrl : '',
  ].filter(Boolean).join('\n');

  return promptBody
    .replace('{{KB_URL}}', cfg.kbUrl)
    .replace('{{REFERENCE_LINES}}', referenceLines)
    .trim();
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function jsonResponse_(obj, statusCode) {
  // Apps Script Web Apps can't set arbitrary HTTP status codes on ContentService
  // output; statusCode is included in the body for the caller's/log's benefit.
  obj.status = statusCode || 200;
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------
// Manual test — run this from the Apps Script editor to test end-to-end
// without needing a real Notion webhook yet.
//
// Set TEST_POSTMORTEM_URL in Script Properties (a real postmortem page URL)
// rather than pasting it into this file — Script Properties survive
// `clasp push`, a value hardcoded here would get overwritten by the next
// push from git.
// ---------------------------------------------------------------
function testRun() {
  const cfg = getConfig_();
  const testPageUrl = PropertiesService.getScriptProperties().getProperty('TEST_POSTMORTEM_URL');
  if (!testPageUrl) {
    throw new Error('Set TEST_POSTMORTEM_URL in Script Properties to a real postmortem page URL first.');
  }
  const summary = runPostmortemReview_(testPageUrl, cfg);
  Logger.log(summary);
  postToSlack_('[TEST] ' + summary, cfg);
}
