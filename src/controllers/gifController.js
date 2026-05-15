const logger = require('../config/logger');

/**
 * Giphy API v1 proxy.
 *
 * Originally targeted Tenor; switched to Giphy in Jan 2026 after Google
 * stopped issuing new Tenor API keys. The proxy keeps the same client-facing
 * response shape ({ gifs: [{id,url,preview,width,height,title}], next }) so
 * the frontend GIF picker didn't need any changes.
 *
 * The API key is held server-side via GIPHY_API_KEY. Putting it on the client
 * is the obvious shortcut but also a footgun — a leaked client key can be
 * yanked from devtools and burn through your quota. The trade-off here:
 * one extra hop, but the key never leaves the server.
 *
 * Get a free developer key at https://developers.giphy.com/dashboard
 *
 * Pagination: Giphy uses offset+limit, not opaque cursors. We round-trip the
 * next offset as a string in the `next` field — the frontend treats it as an
 * opaque cursor and passes it back via `pos`.
 */

const GIPHY_BASE = 'https://api.giphy.com/v1';
const PAGE_LIMIT = 24;

async function giphyProxy(endpoint, params, res) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    logger.warn('GIPHY_API_KEY not set — GIF picker disabled');
    return res.status(503).json({
      success: false,
      data: null,
      message: 'GIF service is not configured.',
    });
  }

  // `pos` is the opaque cursor we handed the client last call — for Giphy it's
  // just the next offset stringified. Parse defensively; bad values fall back
  // to offset 0 rather than erroring.
  const offset = Number.parseInt(params.pos, 10);
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

  const url = new URL(`${GIPHY_BASE}/${endpoint}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('offset', String(safeOffset));
  url.searchParams.set('rating', 'pg'); // family-friendly default
  if (params.q) url.searchParams.set('q', params.q);

  let upstream;
  try {
    upstream = await fetch(url.toString());
  } catch (err) {
    logger.error(`Giphy fetch failed: ${err.message}`);
    return res.status(502).json({
      success: false,
      data: null,
      message: 'GIF service is temporarily unreachable.',
    });
  }

  if (!upstream.ok) {
    // Capture the upstream body so we can see *why* Giphy refused. Common
    // failure modes: invalid/revoked GIPHY_API_KEY (401/403), rate limit (429).
    const upstreamBody = await upstream.text().catch(() => '');
    logger.warn(`Giphy responded ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
    let userMessage = 'GIF service error.';
    if (upstream.status === 429) userMessage = 'Rate limited. Try again in a moment.';
    else if (upstream.status === 401 || upstream.status === 403) {
      userMessage = 'GIF service: API key rejected. Check GIPHY_API_KEY on the server.';
    }
    return res.status(upstream.status === 429 ? 429 : 502).json({
      success: false,
      data: null,
      message: userMessage,
    });
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload || !Array.isArray(payload.data)) {
    return res.status(502).json({ success: false, data: null, message: 'Bad GIF response.' });
  }

  // Flatten Giphy's `images` map into the minimal shape the picker uses.
  // We pick `fixed_width` (200px wide) for the grid preview — small enough to
  // load fast, sharp enough to look good — and `downsized_medium` (capped
  // ~5MB) for the file we hand to the upload pipeline. Falls back to
  // `original` when the downsized variant is missing.
  const gifs = payload.data
    .map((g) => {
      const original = g.images?.original;
      const downsized = g.images?.downsized_medium || g.images?.downsized || original;
      const preview = g.images?.fixed_width || g.images?.fixed_width_small || original;
      const fullUrl = downsized?.url || original?.url;
      if (!fullUrl) return null;
      const w = Number.parseInt(original?.width, 10);
      const h = Number.parseInt(original?.height, 10);
      return {
        id: g.id,
        url: fullUrl,
        preview: preview?.url || fullUrl,
        width: Number.isFinite(w) ? w : null,
        height: Number.isFinite(h) ? h : null,
        title: g.title || '',
      };
    })
    .filter(Boolean);

  // If we got a full page back, more results are probably available — hand
  // the next offset back as the cursor. When Giphy returns fewer than
  // PAGE_LIMIT, we've hit the end.
  const returned = payload.pagination?.count ?? gifs.length;
  const next = returned >= PAGE_LIMIT ? String(safeOffset + PAGE_LIMIT) : null;

  return res.status(200).json({
    success: true,
    data: { gifs, next },
    message: 'OK',
  });
}

exports.search = (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ success: false, data: null, message: 'Missing search query.' });
  }
  return giphyProxy('gifs/search', { q, pos: req.query.pos }, res);
};

exports.featured = (req, res) => {
  return giphyProxy('gifs/trending', { pos: req.query.pos }, res);
};
