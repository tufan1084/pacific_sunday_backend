// Post-report email pipeline.
//
//   notifyAuthorOfReport   → courtesy email to the post author. Anonymized:
//                            never reveals the reporter's identity. Throttled
//                            so a flurry of reports doesn't spam the author.
//   notifyAdminsOfReport   → moderation alert to ADMIN_NOTIFY_EMAIL with the
//                            full context (reporter included). This is the
//                            email that actually drives action.
//
// Both fire from setImmediate after the report is persisted, so the API
// responds immediately and email failures never block or 500 the request.

const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { sendMail } = require('./emailService');
const {
  APP_NAME, BRAND_GOLD, BRAND_MUTED, FRONTEND_URL,
  escape, truncate, wrapHtml, calloutBox, ctaButton,
} = require('./emailTemplates');

// How many reports a post must accumulate before the author is notified.
// Default 1 — every report triggers an email. Bump to 3+ in noisier
// communities to suppress single bad-faith reports.
const MIN_REPORTS_TO_NOTIFY_AUTHOR = parseInt(process.env.MIN_REPORTS_TO_NOTIFY_AUTHOR || '1', 10);

// Don't email the same author about the same post more than once per window.
const AUTHOR_RENOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h
const recentlyNotifiedAuthors = new Map(); // key=`${postId}:${userId}` -> timestamp

// Translate an internal reason slug (e.g. "spam_or_misleading") into a clean,
// user-facing label. Anything we don't recognize is title-cased as a fallback.
const REASON_LABELS = {
  spam: 'Spam or misleading content',
  spam_or_misleading: 'Spam or misleading content',
  harassment: 'Harassment or bullying',
  hate_speech: 'Hate speech',
  nudity: 'Nudity or sexual content',
  violence: 'Violence or graphic content',
  scam: 'Scam or fraud',
  off_topic: 'Off topic for this community',
  other: 'Other',
};
const reasonLabel = (raw) => {
  if (!raw) return 'Community guidelines violation';
  const key = String(raw).toLowerCase().trim();
  if (REASON_LABELS[key]) return REASON_LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

// ─── Author email ───────────────────────────────────────────────────────────
//
// Anonymized — never names the reporter. Tells the author *what* was flagged,
// not *who* flagged it. Tone is neutral, not accusatory: a report is not a
// verdict.
const renderAuthorEmail = ({ authorName, postExcerpt, reasonRaw, postId, reportCount }) => {
  const reason = reasonLabel(reasonRaw);
  const subject = `A community member reported your post`;
  const preheader = `Someone flagged your post for review. Reason: ${reason}.`;

  const body = `
    <h1 style="margin:0 0 8px; font-size:20px; font-weight:600; color:${BRAND_GOLD};">A member reported your post</h1>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      Hi${authorName ? ' ' + escape(authorName) : ''},
    </p>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      A member of the ${APP_NAME} Owners Community has reported one of your posts to our moderation team. Reports are part of how our community keeps a high standard, and a report is not a judgement on its own — every flag is reviewed by a moderator before any action is taken.
    </p>
    ${calloutBox('Reason cited', escape(reason))}
    ${postExcerpt ? calloutBox('Your post', escape(truncate(postExcerpt, 240))) : ''}
    ${reportCount > 1 ? `<p style="margin:0 0 14px; color:${BRAND_MUTED}; font-size:13px; line-height:1.6;">This post has now been flagged by ${reportCount} members.</p>` : ''}
    <h2 style="margin:18px 0 6px; font-size:14px; font-weight:600; color:#FFFFFF;">What happens next</h2>
    <ul style="margin:0 0 16px; padding-left:18px; color:#E5E7EB; font-size:13.5px; line-height:1.7;">
      <li>A moderator will review the post against our community guidelines.</li>
      <li>If no violation is found, no action is taken and the post stays public.</li>
      <li>If a violation is found, you'll receive a separate notice with the specific outcome.</li>
    </ul>
    <p style="margin:0 0 8px; color:${BRAND_MUTED}; font-size:13px; line-height:1.6;">
      For privacy and to protect against retaliation, we don't disclose who filed the report.
    </p>
    ${ctaButton(`${FRONTEND_URL}/post/${postId}`, 'View post')}
  `;

  const text = [
    `A community member reported your post on ${APP_NAME}.`,
    `Reason: ${reason}.`,
    postExcerpt ? `\nYour post:\n"${truncate(postExcerpt, 240)}"` : '',
    reportCount > 1 ? `\nThis post has been flagged by ${reportCount} members.` : '',
    '\nA moderator will review the post against our community guidelines. If no violation is found, no action is taken and the post stays public. If a violation is found, you will receive a separate notice with the specific outcome.',
    '\nFor privacy, we do not disclose who filed the report.',
    `\nView the post: ${FRONTEND_URL}/post/${postId}`,
  ].filter(Boolean).join('\n');

  return { subject, preheader, html: wrapHtml({ title: subject, body, preheader }), text };
};

// ─── Admin email ────────────────────────────────────────────────────────────
//
// Internal moderation alert. Includes reporter identity (admins need it).
const renderAdminEmail = ({ authorEmail, authorUsername, reporterEmail, reporterUsername, postExcerpt, reasonRaw, details, postId, reportCount }) => {
  const reason = reasonLabel(reasonRaw);
  const subject = `[Mod] Post #${postId} reported — ${reason}`;
  const preheader = `New report on post #${postId}. ${reportCount} total. Reason: ${reason}.`;

  const body = `
    <h1 style="margin:0 0 8px; font-size:20px; font-weight:600; color:${BRAND_GOLD};">Post reported</h1>
    <p style="margin:0 0 14px; color:#E5E7EB; font-size:14px; line-height:1.6;">
      A member submitted a report on post <strong>#${postId}</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0; font-size:13px;">
      <tr><td style="padding:6px 0; color:${BRAND_MUTED}; width:120px;">Reason</td><td style="padding:6px 0; color:#FFF;">${escape(reason)}</td></tr>
      <tr><td style="padding:6px 0; color:${BRAND_MUTED};">Author</td><td style="padding:6px 0; color:#FFF;">${escape(authorUsername || '—')}${authorEmail ? ` &lt;${escape(authorEmail)}&gt;` : ''}</td></tr>
      <tr><td style="padding:6px 0; color:${BRAND_MUTED};">Reporter</td><td style="padding:6px 0; color:#FFF;">${escape(reporterUsername || '—')}${reporterEmail ? ` &lt;${escape(reporterEmail)}&gt;` : ''}</td></tr>
      <tr><td style="padding:6px 0; color:${BRAND_MUTED};">Reports total</td><td style="padding:6px 0; color:#FFF;">${reportCount}</td></tr>
    </table>
    ${postExcerpt ? calloutBox('Post content', escape(truncate(postExcerpt, 400))) : ''}
    ${details ? calloutBox('Reporter details', escape(truncate(details, 500))) : ''}
    ${ctaButton(`${FRONTEND_URL}/post/${postId}`, 'Open post')}
  `;

  const text = [
    `Post reported on ${APP_NAME}.`,
    `Post #${postId}`,
    `Reason: ${reason}`,
    `Author: ${authorUsername || '-'}${authorEmail ? ` <${authorEmail}>` : ''}`,
    `Reporter: ${reporterUsername || '-'}${reporterEmail ? ` <${reporterEmail}>` : ''}`,
    `Total reports on this post: ${reportCount}`,
    postExcerpt ? `\nPost content:\n"${truncate(postExcerpt, 400)}"` : '',
    details ? `\nReporter details:\n${truncate(details, 500)}` : '',
    `\nOpen: ${FRONTEND_URL}/post/${postId}`,
  ].filter(Boolean).join('\n');

  return { subject, preheader, html: wrapHtml({ title: subject, body, preheader }), text };
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Best-effort fan-out. Resolves any context the email service needs from the
 * DB (post excerpt, author + reporter info, current report count) and sends
 * the author + admin emails in parallel. Logs failures but never throws.
 */
exports.dispatchPostReportEmails = async ({ postId, reporterId, reason, details }) => {
  try {
    const [post, reporter, reportCount, smtpConfig] = await Promise.all([
      prisma.post.findUnique({
        where: { id: postId },
        select: {
          id: true, content: true, isHidden: true,
          user: { select: { id: true, email: true, username: true, profile: { select: { name: true } } } },
        },
      }),
      prisma.user.findUnique({
        where: { id: reporterId },
        select: { id: true, email: true, username: true },
      }),
      prisma.postReport.count({ where: { postId } }),
      prisma.smtpConfig.findFirst({ select: { superadminEmail: true } }),
    ]);

    if (!post || !post.user?.email) return;

    // Skip author notification if the post has already been hidden by mods —
    // they've been or will be told via the takedown email instead.
    const skipAuthorEmail =
      post.isHidden ||
      reportCount < MIN_REPORTS_TO_NOTIFY_AUTHOR ||
      hasNotifiedRecently(postId, post.user.id);

    const authorPromise = skipAuthorEmail
      ? Promise.resolve()
      : (async () => {
          const { subject, html, text } = renderAuthorEmail({
            authorName: post.user.profile?.name || post.user.username,
            postExcerpt: post.content,
            reasonRaw: reason,
            postId,
            reportCount,
          });
          await sendMail({ to: post.user.email, subject, html, text });
          markNotified(postId, post.user.id);
          logger.info(`[report-email] author notified — postId=${postId}, to=${post.user.email}`);
        })();

    const adminEmail = smtpConfig?.superadminEmail;
    const adminPromise = adminEmail
      ? (async () => {
          const { subject, html, text } = renderAdminEmail({
            authorEmail: post.user.email,
            authorUsername: post.user.username,
            reporterEmail: reporter?.email,
            reporterUsername: reporter?.username,
            postExcerpt: post.content,
            reasonRaw: reason,
            details,
            postId,
            reportCount,
          });
          await sendMail({ to: adminEmail, subject, html, text });
          logger.info(`[report-email] admin notified — postId=${postId}, to=${adminEmail}`);
        })()
      : Promise.resolve();

    const results = await Promise.allSettled([authorPromise, adminPromise]);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn(`[report-email] send failed: ${r.reason?.message || r.reason}`);
      }
    }
  } catch (err) {
    logger.warn(`[report-email] dispatch failed: ${err.message}`);
  }
};

const hasNotifiedRecently = (postId, userId) => {
  const key = `${postId}:${userId}`;
  const last = recentlyNotifiedAuthors.get(key);
  if (!last) return false;
  if (Date.now() - last > AUTHOR_RENOTIFY_WINDOW_MS) {
    recentlyNotifiedAuthors.delete(key);
    return false;
  }
  return true;
};

const markNotified = (postId, userId) => {
  const key = `${postId}:${userId}`;
  recentlyNotifiedAuthors.set(key, Date.now());
  // Lightweight cleanup so the map doesn't grow unbounded over time.
  if (recentlyNotifiedAuthors.size > 5000) {
    const cutoff = Date.now() - AUTHOR_RENOTIFY_WINDOW_MS;
    for (const [k, ts] of recentlyNotifiedAuthors.entries()) {
      if (ts < cutoff) recentlyNotifiedAuthors.delete(k);
    }
  }
};
