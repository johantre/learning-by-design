/**
 * Notion REST API wrapper — every direct call to Notion lives here, and
 * nothing else does. Authenticated with a static internal integration
 * token (NOTION_API_TOKEN) — no OAuth, no refresh, no expiry, unlike the
 * MCP connector this replaced. See docs/SETUP.md step 4 for how to create
 * and share that integration.
 *
 * Notion's Sept-2025 multi-source-database change means a "database" is
 * just a container — actual querying/creating happens against one of its
 * "data sources" (resolveDataSourceId_ below). For a normal, non-wiki
 * database like ours, there's exactly one data source per database.
 */

// ---------------------------------------------------------------
// Low-level request wrapper
// ---------------------------------------------------------------
function notionFetch_(cfg, method, path, bodyObj) {
  const options = {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + cfg.notionApiToken,
      'Notion-Version': cfg.notionApiVersion,
    },
    muteHttpExceptions: true,
  };
  if (bodyObj) {
    options.payload = JSON.stringify(bodyObj);
  }

  const response = UrlFetchApp.fetch('https://api.notion.com' + path, options);
  const status = response.getResponseCode();
  const rawText = response.getContentText();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data empty, rawText still available below */ }

  if (status < 200 || status >= 300) {
    throw new Error(
      'Notion API error (' + status + ') on ' + method.toUpperCase() + ' ' + path + ': ' + rawText
    );
  }
  return data;
}

// Pulls a 32-char page ID out of a raw ID or any Notion page URL shape
// (notion.so/Title-<id>, app.notion.com/p/<id>, ...) and normalizes it to
// the dashed UUID form the API expects.
function extractNotionPageId_(pageUrlOrId) {
  const cleaned = String(pageUrlOrId).trim();
  const match = cleaned.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/
  );
  if (!match) {
    throw new Error('Could not find a Notion page ID in: ' + pageUrlOrId);
  }
  const raw = match[1].replace(/-/g, '');
  return raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' +
    raw.slice(16, 20) + '-' + raw.slice(20);
}

// Resolves + caches a database's single data source ID (Script Properties
// cache-on-first-use, same pattern the old discoverNotionTokenEndpoint_ used).
function resolveDataSourceId_(cfg, databaseIdOrUrl, cachePropertyKey) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(cachePropertyKey);
  if (cached) return cached;

  // Sanitize with the same ID-extraction logic used for page URLs — a
  // Notion database URL's ?v=<viewId> is also a 32-char ID and easy to
  // paste by mistake instead of the real database ID that precedes the
  // "?" (this bit us once during setup). extractNotionPageId_ always
  // takes the first ID-shaped token in the string, which is the real one.
  const databaseId = extractNotionPageId_(databaseIdOrUrl);

  const database = notionFetch_(cfg, 'get', '/v1/databases/' + databaseId, null);
  const dataSources = database.data_sources || [];
  if (dataSources.length === 0) {
    throw new Error(
      'Database ' + databaseId + ' has no data sources — double-check the ' +
      'database ID Script Property and that the integration is shared with it.'
    );
  }
  const dataSourceId = dataSources[0].id;
  props.setProperty(cachePropertyKey, dataSourceId);
  return dataSourceId;
}

function getDataSourceSchema_(cfg, dataSourceId) {
  return notionFetch_(cfg, 'get', '/v1/data_sources/' + dataSourceId, null);
}

// ---------------------------------------------------------------
// Reading
// ---------------------------------------------------------------
function getPageWithBody_(cfg, pageIdOrUrl) {
  const pageId = extractNotionPageId_(pageIdOrUrl);
  const page = notionFetch_(cfg, 'get', '/v1/pages/' + pageId, null);
  return {
    id: pageId,
    url: page.url,
    properties: page.properties,
    bodyText: getBlockChildrenAsText_(cfg, pageId, 0),
  };
}

function getBlockChildrenAsText_(cfg, blockId, depth) {
  if (depth > 6) return ''; // safety guard against pathologically deep nesting
  const lines = [];
  let cursor = null;
  do {
    const query = '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const data = notionFetch_(cfg, 'get', '/v1/blocks/' + blockId + '/children' + query, null);
    (data.results || []).forEach(function (block) {
      lines.push(blockToPlainText_(block));
      if (block.has_children) {
        lines.push(getBlockChildrenAsText_(cfg, block.id, depth + 1));
      }
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return lines.filter(Boolean).join('\n');
}

// Covers the block types postmortem pages actually use. Preserves to_do
// checked-state as [x]/[ ] — the prompt relies on this to detect open
// mitigation actions.
function blockToPlainText_(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return '';
  const text = (data.rich_text || []).map(function (rt) { return rt.plain_text; }).join('');
  if (type === 'to_do') return (data.checked ? '[x] ' : '[ ] ') + text;
  if (type === 'heading_1') return '# ' + text;
  if (type === 'heading_2') return '## ' + text;
  if (type === 'heading_3') return '### ' + text;
  if (type === 'bulleted_list_item' || type === 'numbered_list_item') return '- ' + text;
  return text;
}

function queryDataSource_(cfg, dataSourceId) {
  const results = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = notionFetch_(cfg, 'post', '/v1/data_sources/' + dataSourceId + '/query', body);
    results.push.apply(results, data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function extractTitle_(properties) {
  for (const key in properties) {
    if (properties[key].type === 'title') {
      return (properties[key].title || []).map(function (rt) { return rt.plain_text; }).join('');
    }
  }
  return '(untitled)';
}

function extractMultiSelectNames_(prop) {
  if (!prop || !prop.multi_select) return [];
  return prop.multi_select.map(function (opt) { return opt.name; });
}

function extractRelationIds_(prop) {
  if (!prop || !prop.relation) return [];
  return prop.relation.map(function (rel) { return rel.id; });
}

// Lightweight dump of every OTHER postmortem for Claude to compare
// against — title/failure-class/related-incidents/url only, not full
// body text (that's what the read_notion_page tool is for, on demand).
function dumpTrackerForComparison_(cfg, excludePageId) {
  const dataSourceId = resolveDataSourceId_(cfg, cfg.postmortemsDatabaseId, 'POSTMORTEMS_DATA_SOURCE_ID_RESOLVED');
  const pages = queryDataSource_(cfg, dataSourceId);
  return pages
    .filter(function (page) { return page.id !== excludePageId; })
    .map(function (page) {
      return {
        id: page.id,
        url: page.url,
        title: extractTitle_(page.properties),
        failure_class: extractMultiSelectNames_(page.properties['Failure class']),
        related_incidents: extractRelationIds_(page.properties['Related incidents']),
      };
    });
}

// ---------------------------------------------------------------
// Writing
// ---------------------------------------------------------------
function updatePostmortemProperties_(cfg, pageId, failureClasses, relatedIncidentPageIds) {
  return notionFetch_(cfg, 'patch', '/v1/pages/' + pageId, {
    properties: {
      'Failure class': {
        multi_select: (failureClasses || []).map(function (name) { return { name: name }; }),
      },
      'Related incidents': {
        relation: (relatedIncidentPageIds || []).map(function (id) { return { id: id }; }),
      },
    },
  });
}

// DORMANT — not currently called by anything (ClaudeToolLoop.gs's
// escalation tool is create_tech_council_jira_ticket, in JiraApi.gs, now
// that Tech Council lives in Jira project TC instead of a Notion
// database). Deliberately kept, not deleted: if Tech Council ever moves
// back to Notion, this is ready to wire back in instead of rewriting it.
//
// NOTE — unverified against a live Tech Council Topics entry (no Notion
// access available while writing this): assumes Executive summary /
// Description of the problem / Proposed solution are body content under
// headings (matching the page template CLAUDE.md describes), not flat
// database properties. Verify with a real GET on an existing entry
// before relying on this in production. If they turn out to be
// properties instead, move executiveSummary/descriptionOfProblem into
// the `properties` object below instead of `children`.
//
// Title/Status/Type property *names* and value *types* (status vs.
// select) are resolved dynamically from the data source schema rather
// than hardcoded, since those weren't verifiable either — this should
// make it correct regardless of which type Notion actually uses.
function createTechCouncilDraft_(cfg, title, executiveSummary, descriptionOfProblem) {
  const dataSourceId = resolveDataSourceId_(cfg, cfg.techCouncilDatabaseId, 'TECH_COUNCIL_DATA_SOURCE_ID_RESOLVED');
  const schema = getDataSourceSchema_(cfg, dataSourceId);
  const schemaProperties = schema.properties || {};

  const titlePropertyName = (function () {
    for (const key in schemaProperties) {
      if (schemaProperties[key].type === 'title') return key;
    }
    throw new Error('No title property found on the Tech Council Topics data source.');
  })();

  const properties = {};
  properties[titlePropertyName] = { title: [{ text: { content: title } }] };

  if (schemaProperties['Status']) {
    properties['Status'] = buildTypedOptionValue_(schemaProperties['Status'].type, 'Draft');
  }
  if (schemaProperties['Type']) {
    properties['Type'] = buildTypedOptionValue_(schemaProperties['Type'].type, 'Request for comments');
  }

  const children = [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Executive summary' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: parseMarkdownLinksToRichText_(executiveSummary) } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Description of the problem' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: parseMarkdownLinksToRichText_(descriptionOfProblem) } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Proposed solution' } }] } },
    // intentionally blank — left for the postmortem author to fill in,
    // per the "never write the proposed solution ourselves" design rule.
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
  ];

  return notionFetch_(cfg, 'post', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: properties,
    children: children,
  });
}

// Builds a property value of whatever type the schema says it actually is
// (Notion's dedicated "status" type vs. a plain "select") — avoids
// hardcoding an assumption we couldn't verify live.
function buildTypedOptionValue_(propertyType, optionName) {
  const value = {};
  value[propertyType] = { name: optionName };
  return value;
}

// The raw Notion REST API does not parse Markdown — a plain rich_text
// content string containing "[text](url)" is written as literal bracket
// characters, not a real link (unlike the notion-create-pages MCP tool,
// which does parse Notion-flavored Markdown). Since the prompt instructs
// Claude to use that exact [text](url) syntax for links, we parse it
// ourselves here rather than changing the prompt to avoid a syntax no
// human would naturally write.
function parseMarkdownLinksToRichText_(text) {
  const richText = [];
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      richText.push({ text: { content: text.slice(lastIndex, match.index) } });
    }
    richText.push({ text: { content: match[1], link: { url: match[2] } } });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    richText.push({ text: { content: text.slice(lastIndex) } });
  }
  return richText.length > 0 ? richText : [{ text: { content: text } }];
}
