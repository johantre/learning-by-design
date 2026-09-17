/**
 * Drives the Claude API conversation using Anthropic's native tool-calling
 * (NOT the MCP connector this replaced) so Claude keeps its autonomous
 * step-by-step judgment — classify, decide related incidents, decide
 * escalation — while every tool it calls is implemented right here in
 * this codebase, hitting Notion's and Jira's REST APIs (NotionApi.gs /
 * JiraApi.gs) with a static token each. No OAuth, no beta header, no MCP
 * server involved.
 */

// The target postmortem's full content and a lightweight tracker dump are
// ALWAYS fetched upfront by runPostmortemReview_ (Code.gs) — no reason to
// make those two reads "agentic," they're needed every single run. These
// tools are for judgment calls only: reading a specific prior postmortem
// in more depth, and the two writes whose content only Claude can decide.
const CLAUDE_TOOLS_ = [
  {
    name: 'read_notion_page',
    description:
      "Fetch the full properties and body text of a specific prior postmortem page by its page ID or URL (from the tracker dump), when the tracker summary alone isn't enough to judge relatedness — e.g. comparing the failure narrative or metaphor in depth before deciding Related incidents.",
    input_schema: {
      type: 'object',
      properties: {
        page_id_or_url: { type: 'string', description: 'Notion page ID or URL, taken from the tracker dump.' },
      },
      required: ['page_id_or_url'],
    },
  },
  {
    name: 'update_postmortem_properties',
    description:
      "Write back Failure class and Related incidents on the postmortem currently under review. Call this exactly once, only after you've decided the final values — not speculatively.",
    input_schema: {
      type: 'object',
      properties: {
        failure_classes: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more Failure class option names — an existing cluster name, or "other" if none fit. Never invent a brand-new cluster name.',
        },
        related_incident_page_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Page IDs (from the tracker dump) of prior postmortems in the same failure class. Empty array if none apply.',
        },
      },
      required: ['failure_classes', 'related_incident_page_ids'],
    },
  },
  {
    name: 'create_tech_council_jira_ticket',
    description:
      'Escalate by creating a Jira Task in the Tech Council project (TC). Only call this if the current postmortem is the 3rd or later occurrence of the same failure class. The ticket summary is automatically prefixed with 🩺🧟 by this tool itself, so it\'s recognizable at a glance as postmortem-originated — do NOT include that emoji yourself in `title`, plain text only. It always lands in the project\'s default "To Do" status — you cannot move it further; submitting it for actual discussion at the Tech Council meeting is a human decision.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Plain text — no emoji prefix, that is added automatically.' },
        executive_summary: { type: 'string' },
        description_of_problem: {
          type: 'string',
          description: 'Reference related incidents with plain Markdown links [text](url) — never invented pseudo-tags.',
        },
      },
      required: ['title', 'executive_summary', 'description_of_problem'],
    },
  },
];

const TOOL_LOOP_MAX_ITERATIONS_ = 8;

function callClaude_(systemPrompt, messages, cfg) {
  const payload = {
    model: cfg.claudeModel,
    max_tokens: 2000,
    system: systemPrompt,
    messages: messages,
    tools: CLAUDE_TOOLS_,
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const rawText = response.getContentText();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data empty, rawText still available */ }

  if (status !== 200) {
    throw new Error('Claude API error (' + status + '): ' + rawText);
  }
  return data;
}

// Drives the multi-turn tool-use conversation until Claude returns a final
// text-only response (stop_reason !== 'tool_use'), or bails out after
// TOOL_LOOP_MAX_ITERATIONS_ as a runaway-loop safety net.
function runToolLoop_(systemPrompt, initialUserContent, cfg, targetPageId) {
  const messages = [{ role: 'user', content: initialUserContent }];

  for (let i = 0; i < TOOL_LOOP_MAX_ITERATIONS_; i++) {
    const response = callClaude_(systemPrompt, messages, cfg);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText_(response.content);
    }

    const toolResults = [];
    response.content
      .filter(function (block) { return block.type === 'tool_use'; })
      .forEach(function (block) {
        try {
          const result = dispatchTool_(block.name, block.input, cfg, targetPageId);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (err) {
          // Surfaced back to Claude as a failed tool call (it can retry or
          // adapt), not thrown out of the loop — only a genuine runaway or
          // crash should escape this function.
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: err.message });
        }
      });

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Tool loop exceeded ' + TOOL_LOOP_MAX_ITERATIONS_ + ' iterations without a final text response');
}

function dispatchTool_(toolName, toolInput, cfg, targetPageId) {
  if (toolName === 'read_notion_page') {
    return getPageWithBody_(cfg, toolInput.page_id_or_url);
  }
  if (toolName === 'update_postmortem_properties') {
    // targetPageId is threaded through explicitly, never taken from
    // Claude's tool input — it must always write to the postmortem
    // actually under review, not a page ID it might hallucinate.
    return updatePostmortemProperties_(cfg, targetPageId, toolInput.failure_classes, toolInput.related_incident_page_ids);
  }
  if (toolName === 'create_tech_council_jira_ticket') {
    return createTechCouncilJiraTicket_(cfg, toolInput.title, toolInput.executive_summary, toolInput.description_of_problem);
  }
  throw new Error('Unknown tool: ' + toolName);
}

function extractText_(content) {
  const textBlocks = (content || [])
    .filter(function (block) { return block.type === 'text'; })
    .map(function (block) { return block.text; });
  if (textBlocks.length === 0) {
    throw new Error('Claude returned no text content in its final response: ' + JSON.stringify(content));
  }
  return textBlocks.join('\n');
}
