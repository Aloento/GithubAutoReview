'use strict';

const crypto = require('crypto');

/**
 * Verify the X-Hub-Signature-256 header of a GitHub webhook delivery.
 * Returns true when the HMAC-SHA256 of the raw body matches the header.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    // No secret configured: allow (local dev only).
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected = signatureHeader.slice('sha256='.length);
  const actual = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = { verifySignature };
