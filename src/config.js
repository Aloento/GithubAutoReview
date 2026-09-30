'use strict';

/**
 * Central configuration, read from environment variables.
 * On FunctionGraph these are set in the function's environment config.
 * Locally, put them in a .env file (loaded by index.js).
 */

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function floatEnv(name, fallback) {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  // --- GitHub App ---
  appId: process.env.GITHUB_APP_ID || '',
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  githubApiBase: process.env.GITHUB_API_BASE || 'https://api.github.com',

  // --- LiteLLM (OpenAI-compatible) ---
  litellmBaseUrl: process.env.LITELLM_BASE_URL || '',
  litellmApiKey: process.env.LITELLM_API_KEY || '',
  litellmModel: process.env.LITELLM_MODEL || '',
  llmTimeoutMs: intEnv('LLM_TIMEOUT_MS', 180000),
  // Output token cap. Inputs can be large; the output only needs room for
  // the JSON review.
  llmMaxTokens: intEnv('LLM_MAX_TOKENS', 8192),
  // Low temperature for consistent reviews.
  llmTemperature: floatEnv('LLM_TEMPERATURE', 0.1),

  // --- Review behaviour ---
  // Bot login (e.g. "ai-review[bot]"), used to skip the bot's own comments.
  botLogin: process.env.BOT_LOGIN || '',
  // Mention name that triggers a review in PR comments, e.g. "@ai-review review".
  botMention: process.env.BOT_MENTION || 'ai-review',
  // "auto": REQUEST_CHANGES if critical issues found, APPROVE otherwise.
  // "comment": always post a plain review.
  // "request_changes_if_critical": REQUEST_CHANGES if critical, else COMMENT.
  reviewMode: process.env.REVIEW_MODE || 'auto',
  // Keyword that must appear next to the @bot mention in a comment to
  // trigger a review, e.g. "@ai-review[bot] review".
  triggerWord: (process.env.TRIGGER_WORD || 'review').toLowerCase(),
  // Allow large diffs.
  maxDiffChars: intEnv('MAX_DIFF_CHARS', 800000),
  maxContextFiles: intEnv('MAX_CONTEXT_FILES', 10),
  maxContextFileChars: intEnv('MAX_CONTEXT_FILE_CHARS', 100000),
  maxComments: intEnv('MAX_COMMENTS', 25),
  // Dependency lock files (npm/pnpm/yarn/Go/Cargo/Python/Ruby/PHP/etc.) and
  // generated assets to never review.
  skipPatterns: (process.env.SKIP_PATTERNS ||
    'package-lock.json,yarn.lock,pnpm-lock.yaml,npm-shrinkwrap.json,go.sum,Cargo.lock,composer.lock,Gemfile.lock,Pipfile.lock,poetry.lock,uv.lock,bun.lock,bun.lockb,gradle.lockfile,*.lock,*.min.js,*.min.css,*.map,*.snap,*.svg,*.png,*.jpg,*.jpeg,*.gif,*.ico,*.woff,*.woff2,*.ttf,*.pdf')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// Normalize the PEM key (env vars often mangle newlines).
if (config.privateKey) {
  config.privateKey = config.privateKey
    .replace(/\\n/g, '\n')
    .trim();
  if (!config.privateKey.startsWith('-----BEGIN')) {
    config.privateKey = `-----BEGIN PRIVATE KEY-----\n${config.privateKey}\n-----END PRIVATE KEY-----`;
  }
}

module.exports = config;
