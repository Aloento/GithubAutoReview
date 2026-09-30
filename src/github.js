'use strict';

const config = require('./config');
const { createAppJwt } = require('./jwt');

/**
 * Minimal GitHub REST API client for a GitHub App.
 * - Exchanges the app private key for a short-lived JWT.
 * - Exchanges the JWT for an installation access token (cached until expiry).
 * - Provides the few endpoints the reviewer needs.
 */

const tokenCache = new Map(); // installationId -> { token, expiresAt }
const installationCache = new Map(); // "owner/repo" -> installationId

async function fetchJson(url, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-App-Id': config.appId,
      'User-Agent': 'github-ai-review',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${url} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getAppJwt() {
  return createAppJwt(config.appId, config.privateKey);
}

async function getInstallationToken(installationId) {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const jwt = await getAppJwt();
  const data = await fetchJson(
    `${config.githubApiBase}/app/installations/${installationId}/access_tokens`,
    { method: 'POST', token: jwt, body: {} }
  );

  const entry = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  tokenCache.set(installationId, entry);
  return entry.token;
}

/**
 * Resolve the installation for a repository (owner/repo), cached per process.
 */
async function getInstallationForRepo(owner, repo) {
  const key = `${owner}/${repo}`;
  const cachedId = installationCache.get(key);
  if (cachedId) return { id: cachedId };

  const jwt = await getAppJwt();
  const data = await fetchJson(
    `${config.githubApiBase}/repos/${owner}/${repo}/installation`,
    { token: jwt }
  );
  installationCache.set(key, data.id);
  return data; // { id, account, ... }
}

async function getPullRequest(owner, repo, number) {
  const token = await getInstallationToken(
    (await getInstallationForRepo(owner, repo)).id
  );
  return fetchJson(`${config.githubApiBase}/repos/${owner}/${repo}/pulls/${number}`, { token });
}

async function getPullRequestFiles(owner, repo, number) {
  const token = await getInstallationToken(
    (await getInstallationForRepo(owner, repo)).id
  );
  const files = [];
  let page = 1;
  // Paginate; stop early once we have enough files.
  for (;;) {
    const data = await fetchJson(
      `${config.githubApiBase}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      { token }
    );
    files.push(...data);
    if (data.length < 100) break;
    page += 1;
    if (page > 10) break; // safety cap
  }
  return files;
}

async function getPullRequestLabels(owner, repo, number) {
  const token = await getInstallationToken(
    (await getInstallationForRepo(owner, repo)).id
  );
  const pr = await fetchJson(`${config.githubApiBase}/repos/${owner}/${repo}/issues/${number}`, { token });
  return (pr.labels || []).map((l) => l.name);
}

async function getFileContent(owner, repo, path, ref) {
  const token = await getInstallationToken(
    (await getInstallationForRepo(owner, repo)).id
  );
  const data = await fetchJson(
    `${config.githubApiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { token }
  );
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  return null;
}

/**
 * Submit a PR review with optional line-level comments.
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.number
 * @param {string} opts.body      Overall review summary.
 * @param {string} opts.event     COMMENT | APPROVE | REQUEST_CHANGES
 * @param {Array}  opts.comments  [{ path, line, side, body }]
 */
async function createReview({ owner, repo, number, body, event = 'COMMENT', comments = [] }) {
  const token = await getInstallationToken(
    (await getInstallationForRepo(owner, repo)).id
  );
  return fetchJson(`${config.githubApiBase}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    token,
    body: {
      body,
      event,
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side || 'RIGHT',
        body: c.body,
      })),
    },
  });
}

module.exports = {
  getInstallationForRepo,
  getPullRequest,
  getPullRequestFiles,
  getPullRequestLabels,
  getFileContent,
  createReview,
};
