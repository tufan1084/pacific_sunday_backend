// Shared email scaffolding so every transactional message we send keeps the
// same brand layout, palette, and footer copy. Individual feature services
// (post-report, moderation, future alerts) build their `body` and pass it
// to wrapHtml — never duplicating the wrapper.

const APP_NAME = 'Pacific Sunday';
const BRAND_GOLD = '#E8C96A';
const BRAND_DARK = '#0b1326';
const BRAND_PANEL = '#13192A';
const BRAND_MUTED = '#94A3B8';

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  process.env.NEXT_PUBLIC_FRONTEND_URL ||
  'https://pacific-sunday.vercel.app';

// Logo lives in the Next.js /public folder so it's served as a static asset
// at <FRONTEND_URL>/logo.png — directly embeddable in email clients.
const LOGO_URL = `${FRONTEND_URL}/logo.png`;

// HTML-escape user-controlled strings before interpolating them into a
// template. Belt-and-suspenders against injecting <a href="javascript:..">
// into emails via post content / reasons / names.
const escape = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const truncate = (s, n) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str;
};

// Pull-quote / attention block. Pre-escaped content, gold left border.
const calloutBox = (label, content) => `
  <div style="background:rgba(255,255,255,0.04); border-left:3px solid ${BRAND_GOLD}; border-radius:6px; padding:14px 16px; margin:14px 0;">
    <div style="color:${BRAND_MUTED}; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">${escape(label)}</div>
    <div style="color:#FFFFFF; font-size:13.5px; line-height:1.55; white-space:pre-wrap; word-break:break-word;">${content}</div>
  </div>`;

// Single full-bleed dark layout. Same shell every email uses — header logo,
// body slot, footer disclaimer. Includes Outlook bgcolor fallbacks and a
// 40px dark spacer at the bottom so short emails never reveal a white gutter.
const wrapHtml = ({ title, body, preheader }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="supported-color-schemes" content="dark light" />
  <title>${escape(title)}</title>
  <style>
    html, body { margin:0 !important; padding:0 !important; background:${BRAND_DARK} !important; }
    table { border-collapse:collapse !important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { display:block; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${BRAND_GOLD}; }
  </style>
</head>
<body bgcolor="${BRAND_DARK}" style="margin:0 !important; padding:0 !important; background:${BRAND_DARK} !important; color:#FFFFFF; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; width:100% !important; min-width:100% !important;">
  ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0; visibility:hidden; color:transparent;">${escape(preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND_DARK}" style="background:${BRAND_DARK}; margin:0; padding:0; width:100%; min-width:100%; min-height:100vh;">
    <tr>
      <td bgcolor="${BRAND_DARK}" style="background:${BRAND_DARK}; padding:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND_PANEL}" style="background:${BRAND_PANEL}; width:100%; margin:0; padding:0;">
          <tr>
            <td bgcolor="${BRAND_PANEL}" style="background:${BRAND_PANEL}; padding:22px 28px; border-bottom:1px solid rgba(255,255,255,0.06);">
              <a href="${FRONTEND_URL}" style="text-decoration:none; color:${BRAND_GOLD}; font-size:22px; font-weight:600; letter-spacing:0.5px; font-family:Georgia,'Times New Roman',serif;">
                <img src="${LOGO_URL}" alt="${APP_NAME}" width="180" height="54"
                     style="display:block; width:180px; height:54px; max-width:60%; border:0; outline:none; text-decoration:none; color:${BRAND_GOLD}; font-size:22px; font-weight:600; letter-spacing:0.5px; font-family:Georgia,'Times New Roman',serif; -ms-interpolation-mode:bicubic;" />
              </a>
              <div style="font-size:11px; color:${BRAND_MUTED}; text-transform:uppercase; letter-spacing:1px; margin-top:10px;">Owners Community</div>
            </td>
          </tr>
          <tr>
            <td bgcolor="${BRAND_PANEL}" style="background:${BRAND_PANEL}; padding:28px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td bgcolor="${BRAND_PANEL}" style="background:${BRAND_PANEL}; padding:18px 28px; border-top:1px solid rgba(255,255,255,0.06); color:${BRAND_MUTED}; font-size:11px; line-height:1.6;">
              You're receiving this email as part of the ${APP_NAME} community. For full guidelines visit
              <a href="${FRONTEND_URL}/community" style="color:${BRAND_GOLD}; text-decoration:none;">our community page</a>.
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td bgcolor="${BRAND_DARK}" height="40" style="background:${BRAND_DARK}; height:40px; line-height:40px; font-size:0;">&nbsp;</td>
    </tr>
  </table>
</body>
</html>`;

// Gold call-to-action button (table-based for Outlook compatibility — divs
// with display:inline-block don't render reliably there).
const ctaButton = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;">
    <tr><td bgcolor="${BRAND_GOLD}" style="background:${BRAND_GOLD}; border-radius:6px;">
      <a href="${escape(href)}" style="display:inline-block; padding:10px 18px; color:#060D1F; text-decoration:none; font-weight:600; font-size:13px;">${escape(label)}</a>
    </td></tr>
  </table>`;

module.exports = {
  APP_NAME,
  BRAND_GOLD,
  BRAND_DARK,
  BRAND_PANEL,
  BRAND_MUTED,
  FRONTEND_URL,
  LOGO_URL,
  escape,
  truncate,
  wrapHtml,
  calloutBox,
  ctaButton,
};
