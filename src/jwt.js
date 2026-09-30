'use strict';

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a signed RS256 JWT for authenticating as the GitHub App.
 * Uses only Node's built-in crypto module (no jsonwebtoken dependency).
 */
function createAppJwt(appId, privateKey, ttlSeconds = 540) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: Number(appId),
    iat: now,
    exp: now + ttlSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

module.exports = { createAppJwt };
