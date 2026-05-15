/**
 * Masks an email for safe display on the NFC tap landing page. Since /n is
 * publicly accessible, anyone who taps the bag would see the raw owner email
 * otherwise — strangers/finders shouldn't get a free email-harvest off a chip.
 *
 * "john.doe@example.com"   →  "j***@example.com"
 * "j@example.com"          →  "j***@example.com"
 * Anything malformed       →  "***"
 */
function maskEmail(email) {
  if (typeof email !== 'string') return '***';
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return '***';
  const head = local[0] || '*';
  return `${head}***@${domain}`;
}

module.exports = { maskEmail };
