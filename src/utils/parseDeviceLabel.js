const { UAParser } = require('ua-parser-js');

/**
 * Turns a raw User-Agent string into a short, human-readable label for the
 * scan history. Uses ua-parser-js for the heavy lifting (device DB, model
 * name normalisation) and then picks the most useful combination per
 * platform.
 *
 * Examples
 *   iPhone Safari → "iPhone — iOS 17"
 *   Galaxy S22 Chrome → "Samsung SM-S901B — Android 14"
 *   Pixel 8 Chrome → "Google Pixel 8 — Android 14"
 *   Desktop Chrome on Windows → "Chrome on Windows"
 *   Desktop Safari on Mac → "Safari on macOS"
 *
 * Returns null if the UA is missing or so generic that no useful label can
 * be derived; callers should fall back to "Unknown device".
 */
function parseDeviceLabel(userAgent, hints = {}) {
  // Prefer UA-CH high-entropy values when the client supplied them — those
  // carry the real model name on modern Chromium where the User-Agent has
  // been reduced to "Android 10; K". Strip any surrounding quotes that
  // Sec-CH-UA-* headers ship with.
  const stripQuotes = (v) =>
    typeof v === 'string' ? v.replace(/^"+|"+$/g, '').trim() : null;
  const chModel = stripQuotes(hints.model);
  const chPlatform = stripQuotes(hints.platform);
  const chPlatformVersion = stripQuotes(hints.platformVersion);

  if (chModel && chModel !== 'K') {
    const major = chPlatformVersion ? chPlatformVersion.split('.')[0] : '';
    if (chPlatform && major) return `${chModel} — ${chPlatform} ${major}`;
    if (chPlatform) return `${chModel} — ${chPlatform}`;
    return chModel;
  }

  if (!userAgent || typeof userAgent !== 'string') return null;

  let ua;
  try {
    ua = new UAParser(userAgent).getResult();
  } catch {
    return null;
  }

  const deviceVendor = ua.device?.vendor;
  const deviceModel = ua.device?.model;
  const osName = ua.os?.name;
  const osVersion = ua.os?.version;
  const browserName = ua.browser?.name;

  // ── Mobile / tablet — prefer device-level identifiers
  if (ua.device?.type === 'mobile' || ua.device?.type === 'tablet') {
    // iPhone / iPad: ua-parser doesn't surface the model number (Apple
    // hides it in the UA), so we lean on the OS version for a useful hint.
    if (deviceVendor === 'Apple' || /iPhone|iPad|iPod/i.test(userAgent)) {
      const device = deviceModel || (/iPad/i.test(userAgent) ? 'iPad' : 'iPhone');
      return osVersion ? `${device} — iOS ${osVersion.split('.')[0]}` : device;
    }
    // Android et al: vendor + model gives the most useful identifier the
    // UA actually carries (e.g. "Samsung SM-S918B").
    if (deviceVendor && deviceModel) {
      return osVersion
        ? `${deviceVendor} ${deviceModel} — ${osName || 'Android'} ${osVersion.split('.')[0]}`
        : `${deviceVendor} ${deviceModel}`;
    }
    if (deviceModel) {
      return osName ? `${deviceModel} — ${osName}` : deviceModel;
    }
    if (osName) {
      return osVersion ? `${osName} ${osVersion.split('.')[0]}` : osName;
    }
  }

  // ── Desktop — model is usually empty; use browser + OS instead.
  if (browserName && osName) return `${browserName} on ${osName}`;
  if (osName) return osName;
  if (browserName) return browserName;

  return null;
}

module.exports = { parseDeviceLabel };
