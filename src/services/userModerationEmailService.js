// User-moderation email pipeline.
//
//   notifyPostingBlocked    → sent to a user the moment an admin removes
//                             their ability to post / comment in the
//                             community. Includes the reason if one was
//                             given, and a clear "what this means" section.
//   notifyPostingRestored   → sent when an admin lifts the block. Quick,
//                             positive confirmation that access is back.
//
// Fired from setImmediate after the DB write so admin requests don't block
// on SMTP and email failures never bubble up to the admin UI.

const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { sendMail } = require('./emailService');
const {
  APP_NAME, FRONTEND_URL,
  escape, truncate, wrapHtml, calloutBox, ctaButton,
} = require('./emailTemplates');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || process.env.ADMIN_NOTIFY_EMAIL || null;

// ─── Block email ────────────────────────────────────────────────────────────

const renderBlockedEmail = ({ name, reason }) => {
  const subject = `Your community posting access has been suspended`;
  const preheader = reason
    ? `An administrator suspended your posting access. Reason: ${truncate(reason, 80)}.`
    : `An administrator suspended your posting access in the Owners Community.`;

  const body = `
    <h1 style="margin:0 0 8px; font-size:20px; font-weight:600; color:#E8C96A;">Your community access has been limited</h1>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      Hi${name ? ' ' + escape(name) : ''},
    </p>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      An administrator has temporarily suspended your ability to <strong>create posts and comments</strong> in the ${APP_NAME} Owners Community.
    </p>
    ${reason ? calloutBox('Reason from the moderation team', escape(truncate(reason, 400))) : ''}
    <h2 style="margin:18px 0 6px; font-size:14px; font-weight:600; color:#FFFFFF;">What this means</h2>
    <ul style="margin:0 0 16px; padding-left:18px; color:#E5E7EB; font-size:13.5px; line-height:1.7;">
      <li>You can still log in, browse, and read everything in the community.</li>
      <li>You can't create new posts or comments while the suspension is in place.</li>
      <li>Your existing posts and comments remain visible — they have not been removed.</li>
      <li>Other features (Fantasy Golf, your Bag, Leaderboards) are unaffected.</li>
    </ul>
    <h2 style="margin:18px 0 6px; font-size:14px; font-weight:600; color:#FFFFFF;">If you think this is a mistake</h2>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:13.5px; line-height:1.6;">
      Reply to this email${SUPPORT_EMAIL ? ` or reach us at <a href="mailto:${escape(SUPPORT_EMAIL)}" style="color:#E8C96A; text-decoration:none;">${escape(SUPPORT_EMAIL)}</a>` : ''} and a moderator will review the decision. We aim to respond within 1–2 business days.
    </p>
    ${ctaButton(`${FRONTEND_URL}/community`, 'Open the community')}
  `;

  const text = [
    `Your community posting access has been suspended on ${APP_NAME}.`,
    reason ? `\nReason from the moderation team:\n"${truncate(reason, 400)}"` : '',
    '\nWhat this means:',
    '- You can still log in, browse, and read everything in the community.',
    '- You cannot create new posts or comments while the suspension is in place.',
    '- Your existing posts and comments remain visible — they have not been removed.',
    '- Other features (Fantasy Golf, your Bag, Leaderboards) are unaffected.',
    `\nIf you think this is a mistake, reply to this email${SUPPORT_EMAIL ? ` or write to ${SUPPORT_EMAIL}` : ''} and a moderator will review the decision.`,
    `\nCommunity: ${FRONTEND_URL}/community`,
  ].filter(Boolean).join('\n');

  return { subject, preheader, html: wrapHtml({ title: subject, body, preheader }), text };
};

// ─── Restore email ──────────────────────────────────────────────────────────

const renderRestoredEmail = ({ name }) => {
  const subject = `Your community access has been restored`;
  const preheader = `You can post and comment in the Owners Community again.`;

  const body = `
    <h1 style="margin:0 0 8px; font-size:20px; font-weight:600; color:#E8C96A;">Your community access has been restored</h1>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      Hi${name ? ' ' + escape(name) : ''},
    </p>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      Good news — a moderator has lifted the suspension on your account. You can now create posts and comments in the ${APP_NAME} Owners Community again.
    </p>
    <p style="margin:0 0 14px; color:#94A3B8; font-size:13px; line-height:1.6;">
      Thanks for being part of the community. As a reminder, our community guidelines are linked at the bottom of every page.
    </p>
    ${ctaButton(`${FRONTEND_URL}/community`, 'Back to community')}
  `;

  const text = [
    `Your community access has been restored on ${APP_NAME}.`,
    `\nGood news — a moderator has lifted the suspension on your account. You can now create posts and comments in the Owners Community again.`,
    `\nCommunity: ${FRONTEND_URL}/community`,
  ].join('\n');

  return { subject, preheader, html: wrapHtml({ title: subject, body, preheader }), text };
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Send the appropriate moderation email to a user whose posting status just
 * changed. Best-effort: logs failures, never throws, never blocks the admin
 * action that triggered it.
 */
exports.dispatchPostingStatusEmail = async ({ userId, blocked, reason }) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        username: true,
        profile: { select: { name: true } },
      },
    });
    if (!user || !user.email) {
      logger.warn(`[moderation-email] no email for user ${userId}, skipping`);
      return;
    }
    const displayName = user.profile?.name || user.username || null;

    const tpl = blocked
      ? renderBlockedEmail({ name: displayName, reason })
      : renderRestoredEmail({ name: displayName });

    await sendMail({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    logger.info(`[moderation-email] ${blocked ? 'blocked' : 'restored'} email sent to userId=${userId}`);
  } catch (err) {
    logger.warn(`[moderation-email] dispatch failed for userId=${userId}: ${err.message}`);
  }
};
