const crypto = require('crypto');
const { prisma } = require('../config/db');
const logger = require('../config/logger');

// Tokens live for 1 hour by default; configurable per env.
const TTL_MINUTES = parseInt(process.env.NFC_LOGIN_TOKEN_TTL_MINUTES || '60', 10);

// In production this gate is required. Local/dev can opt-out so the seeded
// DEV-UID-* bags can still hit /login without round-tripping through /n.
const REQUIRE_NFC_TOKEN = process.env.REQUIRE_NFC_TOKEN !== 'false';

/**
 * Mints a fresh single-use token for an NFC tap on a registered bag.
 * Stored alongside the userId + bagUid the tap came from; the login endpoint
 * verifies the userId match so a token from bag A can't be used to log into
 * the account of bag B.
 */
async function issueToken({ userId, bagUid }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);
  await prisma.nfcLoginToken.create({
    data: { token, userId, bagUid, expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Validates a token submitted with /auth/login (or forgot/reset). Returns the
 * stored row on success, or { error } describing why it failed.
 *
 * Does NOT mark the token used — that happens in `consumeToken` once the
 * caller has confirmed the rest of the login (PIN match, device check) is
 * good. This way a wrong-PIN attempt doesn't burn the token.
 */
async function validateToken(token, { expectedUserId } = {}) {
  if (!token) return { error: 'NFC_TOKEN_MISSING' };
  const row = await prisma.nfcLoginToken.findUnique({ where: { token } });
  if (!row) return { error: 'NFC_TOKEN_INVALID' };
  if (row.usedAt) return { error: 'NFC_TOKEN_USED' };
  if (row.expiresAt < new Date()) return { error: 'NFC_TOKEN_EXPIRED' };
  if (expectedUserId != null && row.userId !== expectedUserId) {
    return { error: 'NFC_TOKEN_MISMATCH' };
  }
  return { row };
}

async function consumeToken(id) {
  await prisma.nfcLoginToken.update({
    where: { id },
    data: { usedAt: new Date() },
  });
}

/**
 * Best-effort cleanup of expired/used rows older than 24h. Safe to call from
 * any controller; not on a critical path.
 */
async function pruneOld() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    await prisma.nfcLoginToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff } },
          { usedAt: { not: null, lt: cutoff } },
        ],
      },
    });
  } catch (err) {
    logger.warn(`nfcTokenService.pruneOld failed: ${err.message}`);
  }
}

module.exports = {
  issueToken,
  validateToken,
  consumeToken,
  pruneOld,
  REQUIRE_NFC_TOKEN,
  TTL_MINUTES,
};
