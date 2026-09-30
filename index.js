'use strict';

/**
 * Entry point.
 *
 * - On a serverless function platform (e.g. FunctionGraph), export `handler`
 *   and set the function's handler to `index.handler`.
 * - Locally, run `node index.js` to start a dev server on PORT (default 8080)
 *   that accepts GitHub webhook POSTs at /webhook.
 */

// Load .env if present (tiny parser, no dependency). Must run before
// requiring ./src/config, which reads process.env at module load time.
// Handles a UTF-8 BOM and strips optional surrounding quotes.
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  let raw = fs.readFileSync(envFile, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const config = require('./src/config');
const { verifySignature } = require('./src/webhook');
const { reviewPullRequest } = require('./src/reviewer');

const log = (...args) => console.log(new Date().toISOString(), ...args);
const logErr = (...args) => console.error(new Date().toISOString(), ...args);

/**
 * Log which required env vars are set (values masked) so misconfiguration
 * is visible in the function's startup log.
 */
function logConfigStatus() {
  const check = (name, value) =>
    value ? `set (${String(value).length} chars)` : 'MISSING';
  log(
    '[config] GITHUB_APP_ID=' + check('GITHUB_APP_ID', config.appId) +
    ' GITHUB_APP_PRIVATE_KEY=' + check('GITHUB_APP_PRIVATE_KEY', config.privateKey) +
    ' WEBHOOK_SECRET=' + check('WEBHOOK_SECRET', config.webhookSecret) +
    ' LITELLM_BASE_URL=' + check('LITELLM_BASE_URL', config.litellmBaseUrl) +
    ' LITELLM_API_KEY=' + check('LITELLM_API_KEY', config.litellmApiKey) +
    ' LITELLM_MODEL=' + (config.litellmModel || 'MISSING') +
    ' BOT_LOGIN=' + (config.botLogin || 'MISSING')
  );
  if (config.privateKey && !config.privateKey.includes('PRIVATE KEY')) {
    logErr('[config] WARNING: GITHUB_APP_PRIVATE_KEY does not look like a PEM key');
  }
}

/**
 * Run the review pipeline for one PR and post the result.
 */
async function runReview(owner, repo, number, deliveryId) {
  try {
    const result = await reviewPullRequest(owner, repo, number);
    log(
      `[webhook ${deliveryId}] review posted: ${result.review.comments.length} comments, ` +
        `critical=${result.review.critical}, event=${result.event}`
    );
    return { statusCode: 200, body: `review posted (${result.event})` };
  } catch (err) {
    logErr(`[webhook ${deliveryId}] review failed for ${owner}/${repo}#${number}:`, err.message);
    // Return 200 so GitHub does not retry (we log the failure instead).
    return { statusCode: 200, body: 'review failed: ' + err.message };
  }
}

/**
 * Process one webhook event. Returns an HTTP-style response object.
 */
async function processEvent(rawBody, headers) {
  const event = headers['x-github-event'] || '';
  const deliveryId = headers['x-github-delivery'] || 'unknown';

  if (!verifySignature(rawBody, headers['x-hub-signature-256'], config.webhookSecret)) {
    logErr(`[webhook ${deliveryId}] signature verification FAILED`);
    return { statusCode: 403, body: 'invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'invalid JSON' };
  }

  // --- issue_comment: "@bot review" in a PR comment triggers a review ---
  if (event === 'issue_comment') {
    const comment = payload.comment;
    const issue = payload.issue;
    if (!comment || !issue) return { statusCode: 400, body: 'no comment/issue in payload' };
    // Only PRs have a pull_request key on the issue object.
    if (!issue.pull_request) {
      return { statusCode: 200, body: 'ignored: not a PR comment' };
    }
    if (!isBotMentionTrigger(comment.body)) {
      return { statusCode: 200, body: 'ignored: no @bot trigger' };
    }
    // Ignore comments written by the bot itself (avoid loops).
    const author = comment.user?.login || '';
    if (author === config.botLogin || author.endsWith('[bot]')) {
      return { statusCode: 200, body: 'skipped bot comment' };
    }
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const number = issue.number;
    if (!owner || !repo || !number) {
      return { statusCode: 400, body: 'missing owner/repo/number' };
    }
    log(`[webhook ${deliveryId}] @bot review requested in comment on ${owner}/${repo}#${number}`);
    return runReview(owner, repo, number, deliveryId);
  }

  // --- pull_request: all PR lifecycle actions ---
  if (event !== 'pull_request') {
    return { statusCode: 200, body: 'ignored event: ' + event };
  }

  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) {
    return { statusCode: 400, body: 'no pull_request in payload' };
  }

  const owner = pr.base?.repo?.owner?.login;
  const repo = pr.base?.repo?.name;
  const number = pr.number;
  if (!owner || !repo || !number) {
    return { statusCode: 400, body: 'missing owner/repo/number' };
  }

  // opened / reopened (synchronize is ignored to avoid spamming the PR
  // with a new review on every push).
  if (!['opened', 'reopened'].includes(action)) {
    return { statusCode: 200, body: 'ignored action: ' + action };
  }

  // Skip PRs authored by bots (avoid review loops).
  const author = pr.user?.login || '';
  if (author.endsWith('[bot]')) {
    log(`[webhook ${deliveryId}] skipping bot PR ${owner}/${repo}#${number} by ${author}`);
    return { statusCode: 200, body: 'skipped bot PR' };
  }

  // Auto-review: every new PR opened on an installed repo is reviewed.
  log(`[webhook ${deliveryId}] reviewing ${owner}/${repo}#${number} (action=${action})`);
  return runReview(owner, repo, number, deliveryId);
}

/**
 * True when the comment contains the bot mention followed by the trigger
 * word, e.g. "@ai-review review". Matching is case-insensitive.
 */
function isBotMentionTrigger(body) {
  if (!config.botMention || !body) return false;
  const text = String(body).toLowerCase();
  const mention = config.botMention.toLowerCase();
  const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trigger = config.triggerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `@${escapedMention}\\s*[\\s:,.!\\-]*\\s*${trigger}\\b`,
    'g'
  );
  return re.test(text);
}

/**
 * FunctionGraph HTTP trigger handler.
 * The platform passes an event object with `body` (base64-encoded) and `headers`.
 */
exports.handler = async (event, context) => {
  let rawBody = '';
  let headers = {};

  // FunctionGraph passes the event as a JSON string or object.
  const evt = typeof event === 'string' ? JSON.parse(event) : event || {};
  headers = evt.headers || {};
  // Normalize header names to lowercase.
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  headers = lowerHeaders;

  if (evt.body) {
    rawBody = Buffer.from(evt.body, evt.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
  } else if (typeof evt.body === 'string') {
    rawBody = evt.body;
  }

  const result = await processEvent(rawBody, headers);

  return {
    statusCode: result.statusCode,
    headers: { 'Content-Type': 'text/plain' },
    body: result.body,
  };
};

// Log config status on cold start (FunctionGraph) so missing env vars are
// visible in the function log.
logConfigStatus();

// --- Local development server ---
if (require.main === module) {
  const http = require('http');
  const port = parseInt(process.env.PORT || '8080', 10);

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        try {
          const result = await processEvent(rawBody, req.headers);
          res.writeHead(result.statusCode, { 'Content-Type': 'text/plain' });
          res.end(result.body);
        } catch (err) {
          logErr('unhandled error:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('internal error: ' + err.message);
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, () => {
    log(`local dev server listening on http://localhost:${port}/webhook`);
  });
}
