/**
 * Posting the final summary (or a failure notice) to Slack.
 */
function postToSlack_(text, cfg) {
  if (!cfg.slackWebhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL not configured');
  }
  UrlFetchApp.fetch(cfg.slackWebhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
}
