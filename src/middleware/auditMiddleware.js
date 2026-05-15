const auditService = require('../services/auditService');

// Best-effort extraction of the caller IP. Express already resolves
// X-Forwarded-For when trust proxy is set (it is, in app.js).
const extractIp = (req) => req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;

/**
 * Globally-mounted middleware that does two things:
 *   1. Attaches `req.audit(event)` so controllers can emit explicit events.
 *   2. On `res.finish`, AUTO-logs every non-GET request that wasn't already
 *      explicitly audited — for both user-panel and admin-panel mutations.
 *
 * Result: any new endpoint (user or admin) is captured the moment it ships,
 * with zero extra code in the controller. Explicit `req.audit()` calls still
 * win and suppress the auto-row via `req._auditedExplicitly = true`.
 */
const attachAuditLogger = (req, res, next) => {
  // Snapshot body BEFORE downstream handlers mutate / strip it.
  const bodyCopy = req.body && typeof req.body === 'object' ? safeCloneBody(req.body) : req.body;

  req.audit = (event) => {
    const actor = resolveActor(req);
    auditService.logEvent({
      ...actor,
      ...event,
      ipAddress: event.ipAddress ?? extractIp(req),
      userAgent: event.userAgent ?? req.headers['user-agent'] ?? null,
    });
    req._auditedExplicitly = true;
  };

  res.on('finish', () => {
    try {
      if (req._auditedExplicitly) return;
      if (shouldSkipAutoLog(req)) return;

      // Admin auto-logging is handled by the dedicated middleware mounted in
      // adminRoutes.js so that admin-specific skip-rules and category
      // inference run there. Skip it here.
      if (req.path.startsWith('/api/admin')) return;

      // User-side auto-log: only authenticated user actions. Anonymous
      // mutations (e.g. POST /auth/login) are captured by their explicit
      // calls in authController.
      if (!req.user) return;

      const success = res.statusCode >= 200 && res.statusCode < 400;
      const { action, category, entityType, entityId } = inferUserEvent(req);

      const actor = resolveActor(req);
      auditService.logEvent({
        ...actor,
        action,
        category,
        entityType,
        entityId,
        status: success ? 'SUCCESS' : 'FAILED',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          params: req.params,
          query: req.query,
          body: bodyCopy,
        },
      });
    } catch {
      // never throw from finish — auditService.logEvent already swallows DB
      // errors; this catch handles purely synchronous failures (e.g. weird
      // body objects).
    }
  });

  next();
};

const resolveActor = (req) => {
  if (req.admin) {
    return {
      actorId: req.admin.id,
      actorType: 'ADMIN',
      actorName: req.admin.email || req.admin.username || `Admin #${req.admin.id}`,
    };
  }
  if (req.user) {
    return {
      actorId: req.user.id,
      actorType: 'USER',
      actorName:
        req.user.profile?.name ||
        req.user.username ||
        req.user.email ||
        `User #${req.user.id}`,
    };
  }
  return { actorId: null, actorType: 'SYSTEM', actorName: null };
};

// Returns a plain JSON-safe clone, skipping any non-serialisable values that
// would break JSON.stringify in auditService.clampMetadata. Buffers from
// multer uploads are the typical culprit.
const safeCloneBody = (body) => {
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return { unserialisable: true };
  }
};

// ─── Auto-log skip list ────────────────────────────────────────────────────
// High-frequency, low-value endpoints we never want to capture. Without
// these we'd record a row every time the chat composer reports "typing".
const AUTO_LOG_SKIP_RULES = [
  // Health / read shapes
  { method: '*',    pathRegex: /^\/api\/health/ },
  { method: 'GET',  pathRegex: /.*/ }, // belt + braces — auto-log only runs on res.finish, we filter again here

  // Audit log endpoints would otherwise log themselves on every page load.
  { method: '*',    pathRegex: /^\/api\/admin\/audit-(logs|settings)/ },

  // Chat / messaging is never audited — private DM content must not land in
  // an admin-readable table. This blanket rule covers send / media / react /
  // edit / delete / typing / read for every conversation.
  { method: '*',    pathRegex: /^\/api\/chat\// },

  // Notification mark-as-read fires constantly as the user scrolls.
  { method: 'PATCH', pathRegex: /^\/api\/notifications\/.*\/read/ },
  { method: 'POST',  pathRegex: /^\/api\/notifications\/mark-all-read/ },

  // Cache-busting refresh pings.
  { method: 'POST', pathRegex: /^\/api\/leaderboard\/refresh/ },

  // /auth/me-style identity probes (already filtered by GET rule above, but
  // listed for clarity).
];

const shouldSkipAutoLog = (req) => {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return true;
  const fullPath = req.originalUrl.split('?')[0];
  return AUTO_LOG_SKIP_RULES.some(
    (rule) => (rule.method === '*' || rule.method === req.method) && rule.pathRegex.test(fullPath),
  );
};

// ─── Action / category inference for user-side routes ─────────────────────
// The goal: a glance at the audit table should be enough to know what
// happened, without needing to inspect metadata.

const METHOD_VERB = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };

// Map specific user-route patterns to a precise action + category + entity.
// Order matters — first match wins.
const USER_ROUTE_RULES = [
  // H2H challenges
  { re: /^\/api\/h2h\/challenges\/(\d+)\/accept$/,         method: 'POST',   action: 'H2H_CHALLENGE_ACCEPT',   category: 'H2H',     entityType: 'Challenge', idGroup: 1 },
  { re: /^\/api\/h2h\/challenges\/(\d+)\/decline$/,        method: 'POST',   action: 'H2H_CHALLENGE_DECLINE',  category: 'H2H',     entityType: 'Challenge', idGroup: 1 },
  { re: /^\/api\/h2h\/challenges\/(\d+)\/cancel$/,         method: 'POST',   action: 'H2H_CHALLENGE_CANCEL',   category: 'H2H',     entityType: 'Challenge', idGroup: 1 },
  { re: /^\/api\/h2h\/challenges\/(\d+)\/picks\/lock$/,    method: 'POST',   action: 'H2H_PICKS_LOCK',         category: 'H2H',     entityType: 'Challenge', idGroup: 1 },
  { re: /^\/api\/h2h\/challenges\/(\d+)\/picks$/,          method: 'PUT',    action: 'H2H_PICKS_SAVE',         category: 'H2H',     entityType: 'Challenge', idGroup: 1 },
  { re: /^\/api\/h2h\/challenges$/,                        method: 'POST',   action: 'H2H_CHALLENGE_CREATE',   category: 'H2H',     entityType: 'Challenge' },

  // Posts / comments / likes / reports
  { re: /^\/api\/posts\/(\d+)\/likes?$/,                   method: 'POST',   action: 'POST_LIKE',              category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/likes?$/,                   method: 'DELETE', action: 'POST_UNLIKE',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/comments$/,                 method: 'POST',   action: 'POST_COMMENT_CREATE',    category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/comments\/(\d+)$/,          method: 'DELETE', action: 'POST_COMMENT_DELETE',    category: 'POST',    entityType: 'Comment',   idGroup: 2 },
  { re: /^\/api\/posts\/(\d+)\/reports?$/,                 method: 'POST',   action: 'POST_REPORT',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/reshares?$/,                method: 'POST',   action: 'POST_RESHARE',           category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/pin$/,                      method: 'POST',   action: 'POST_PIN',               category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/pin$/,                      method: 'DELETE', action: 'POST_UNPIN',             category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/hide$/,                     method: 'POST',   action: 'POST_HIDE',              category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)$/,                           method: 'DELETE', action: 'POST_DELETE',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)$/,                           method: 'PUT',    action: 'POST_UPDATE',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)$/,                           method: 'PATCH',  action: 'POST_UPDATE',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts$/,                                  method: 'POST',   action: 'POST_CREATE',            category: 'POST',    entityType: 'Post' },

  // Saved posts
  { re: /^\/api\/posts\/(\d+)\/save$/,                     method: 'POST',   action: 'POST_SAVE',              category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/posts\/(\d+)\/save$/,                     method: 'DELETE', action: 'POST_UNSAVE',            category: 'POST',    entityType: 'Post',      idGroup: 1 },
  { re: /^\/api\/saved-categories(\/.*)?$/,                method: 'POST',   action: 'SAVED_CATEGORY_CREATE',  category: 'POST',    entityType: 'SavedCategory' },
  { re: /^\/api\/saved-categories\/(\d+)$/,                method: 'DELETE', action: 'SAVED_CATEGORY_DELETE',  category: 'POST',    entityType: 'SavedCategory', idGroup: 1 },
  { re: /^\/api\/saved-categories\/(\d+)$/,                method: 'PUT',    action: 'SAVED_CATEGORY_UPDATE',  category: 'POST',    entityType: 'SavedCategory', idGroup: 1 },

  // Teams
  { re: /^\/api\/teams\/(\d+)\/join$/,                     method: 'POST',   action: 'TEAM_JOIN_REQUEST',      category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/leave$/,                    method: 'POST',   action: 'TEAM_LEAVE',             category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/invite/,                    method: 'POST',   action: 'TEAM_INVITE',            category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/invites?\/(\d+)\/accept$/,  method: 'POST',   action: 'TEAM_INVITE_ACCEPT',     category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/invites?\/(\d+)\/decline$/, method: 'POST',   action: 'TEAM_INVITE_DECLINE',    category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/requests?\/(\d+)\/approve$/,method: 'POST',   action: 'TEAM_JOIN_APPROVE',      category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)\/requests?\/(\d+)\/reject$/, method: 'POST',   action: 'TEAM_JOIN_REJECT',       category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)$/,                           method: 'DELETE', action: 'TEAM_DELETE',            category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)$/,                           method: 'PUT',    action: 'TEAM_UPDATE',            category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams\/(\d+)$/,                           method: 'PATCH',  action: 'TEAM_UPDATE',            category: 'TEAM',    entityType: 'Team',      idGroup: 1 },
  { re: /^\/api\/teams$/,                                  method: 'POST',   action: 'TEAM_CREATE',            category: 'TEAM',    entityType: 'Team' },

  // Follow / users
  { re: /^\/api\/users\/(\d+)\/follow$/,                   method: 'POST',   action: 'USER_FOLLOW',            category: 'USER',    entityType: 'User',      idGroup: 1 },
  { re: /^\/api\/users\/(\d+)\/follow$/,                   method: 'DELETE', action: 'USER_UNFOLLOW',          category: 'USER',    entityType: 'User',      idGroup: 1 },
  { re: /^\/api\/users\/(\d+)\/follow-requests?\/accept$/, method: 'POST',   action: 'USER_FOLLOW_ACCEPT',     category: 'USER',    entityType: 'User',      idGroup: 1 },
  { re: /^\/api\/users\/(\d+)\/follow-requests?\/reject$/, method: 'POST',   action: 'USER_FOLLOW_REJECT',     category: 'USER',    entityType: 'User',      idGroup: 1 },
  { re: /^\/api\/users\/(\d+)\/block$/,                    method: 'POST',   action: 'USER_BLOCK',             category: 'USER',    entityType: 'User',      idGroup: 1 },

  // Profile
  { re: /^\/api\/profile(\/.*)?$/,                         method: 'PUT',    action: 'PROFILE_UPDATE',         category: 'USER',    entityType: 'UserProfile' },
  { re: /^\/api\/profile(\/.*)?$/,                         method: 'PATCH',  action: 'PROFILE_UPDATE',         category: 'USER',    entityType: 'UserProfile' },
  { re: /^\/api\/profile\/privacy$/,                       method: 'PUT',    action: 'PROFILE_PRIVACY_UPDATE', category: 'USER',    entityType: 'UserProfile' },

  // Fantasy picks (regular tournament picks, not H2H)
  { re: /^\/api\/golf\/picks(\/.*)?$/,                     method: 'POST',   action: 'FANTASY_PICKS_SUBMIT',   category: 'POINTS',  entityType: 'UserPick' },
  { re: /^\/api\/golf\/picks(\/.*)?$/,                     method: 'PUT',    action: 'FANTASY_PICKS_UPDATE',   category: 'POINTS',  entityType: 'UserPick' },

  // Rewards
  { re: /^\/api\/rewards\/(\d+)\/redeem$/,                 method: 'POST',   action: 'REWARD_REDEEM',          category: 'REWARD',  entityType: 'Reward',    idGroup: 1 },
  { re: /^\/api\/rewards\/redeem$/,                        method: 'POST',   action: 'REWARD_REDEEM',          category: 'REWARD',  entityType: 'Reward' },

  // Devices
  { re: /^\/api\/auth\/devices\/(\d+)$/,                   method: 'DELETE', action: 'DEVICE_REVOKE',          category: 'AUTH',    entityType: 'UserDevice', idGroup: 1 },
  { re: /^\/api\/auth\/verify-device-otp$/,                method: 'POST',   action: 'DEVICE_OTP_VERIFY',      category: 'AUTH' },
  { re: /^\/api\/auth\/forgot-password$/,                  method: 'POST',   action: 'PIN_RESET_REQUEST',      category: 'AUTH' },
  { re: /^\/api\/auth\/verify-otp$/,                       method: 'POST',   action: 'PIN_RESET_OTP_VERIFY',   category: 'AUTH' },
  { re: /^\/api\/auth\/reset-password$/,                   method: 'POST',   action: 'PIN_RESET_CONFIRM',      category: 'AUTH' },
  { re: /^\/api\/auth\/verify-email-otp$/,                 method: 'POST',   action: 'EMAIL_VERIFY',           category: 'AUTH' },
  { re: /^\/api\/auth\/send-verification-otp$/,            method: 'POST',   action: 'EMAIL_VERIFY_REQUEST',   category: 'AUTH' },

  // Announcements (user-side: dismiss)
  { re: /^\/api\/announcements\/(\d+)\/dismiss$/,          method: 'POST',   action: 'ANNOUNCEMENT_DISMISS',   category: 'ANNOUNCEMENT', entityType: 'Announcement', idGroup: 1 },

  // Bag tap / registration (user side)
  { re: /^\/api\/bag\/register$/,                          method: 'POST',   action: 'BAG_REGISTER',           category: 'BAG',     entityType: 'Bag' },
  { re: /^\/api\/bag\/(.+)\/tap$/,                         method: 'POST',   action: 'BAG_TAP',                category: 'BAG',     entityType: 'Bag',       idGroup: 1 },

  // NOTE: chat/messaging endpoints are intentionally NOT logged — see the
  // blanket /api/chat skip in AUTO_LOG_SKIP_RULES. Logging DMs would put
  // private message content into an admin-readable audit table.
];

// Heuristic fallback when no specific rule matched.
const inferGenericCategory = (path) => {
  if (path.startsWith('/api/auth')) return 'AUTH';
  if (path.startsWith('/api/users')) return 'USER';
  if (path.startsWith('/api/profile')) return 'USER';
  if (path.startsWith('/api/posts')) return 'POST';
  if (path.startsWith('/api/teams')) return 'TEAM';
  if (path.startsWith('/api/h2h')) return 'H2H';
  if (path.startsWith('/api/challenges')) return 'H2H';
  if (path.startsWith('/api/rewards')) return 'REWARD';
  if (path.startsWith('/api/bag')) return 'BAG';
  if (path.startsWith('/api/golf')) return 'POINTS';
  if (path.startsWith('/api/points')) return 'POINTS';
  if (path.startsWith('/api/tags')) return 'TAG';
  if (path.startsWith('/api/announcements')) return 'ANNOUNCEMENT';
  if (path.startsWith('/api/chat')) return 'CHAT';
  if (path.startsWith('/api/notifications')) return 'USER';
  return 'SYSTEM';
};

const inferGenericAction = (method, path) => {
  const verb = METHOD_VERB[method] || method;
  const cleaned = path
    .replace(/^\/api\//, '')
    .split('/')
    .filter((s) => s && !/^\d+$/.test(s) && !/^[0-9a-f]{20,}$/i.test(s))
    .map((s) => s.replace(/[^a-z0-9]+/gi, '_').toUpperCase())
    .join('_');
  return `${cleaned}_${verb}`;
};

const inferUserEvent = (req) => {
  const path = req.originalUrl.split('?')[0];
  const method = req.method;

  for (const rule of USER_ROUTE_RULES) {
    if (rule.method && rule.method !== method) continue;
    const match = rule.re.exec(path);
    if (match) {
      return {
        action: rule.action,
        category: rule.category,
        entityType: rule.entityType || null,
        entityId: rule.idGroup && match[rule.idGroup] ? match[rule.idGroup] : null,
      };
    }
  }

  return {
    action: inferGenericAction(method, path),
    category: inferGenericCategory(path),
    entityType: null,
    entityId: null,
  };
};

// ─── Admin-only auto-logger (kept for adminRoutes.js mount) ────────────────
// Largely the same logic as the generic finish-hook above, but stays mounted
// under /api/admin so its skip list can be tightly scoped. Categories for
// admin routes are inferred separately because the path stem differs.

const ADMIN_AUTO_LOG_SKIP_PREFIXES = [
  '/audit-logs',
  '/audit-settings',
  '/dashboard-stats',
  '/auth/me',
];

const inferAdminCategory = (path) => {
  if (path.startsWith('/users')) return 'USER';
  if (path.startsWith('/posts')) return 'POST';
  if (path.startsWith('/tags') || path.startsWith('/keywords')) return 'TAG';
  if (path.startsWith('/announcements')) return 'ANNOUNCEMENT';
  if (path.startsWith('/challenges')) return 'ADMIN';
  if (path.startsWith('/h2h')) return 'H2H';
  if (path.startsWith('/golf-settings')) return 'ADMIN';
  if (path.startsWith('/smtp-config')) return 'ADMIN';
  if (path.startsWith('/sync-bags') || path.startsWith('/bag-types')) return 'BAG';
  if (path.startsWith('/auth')) return 'AUTH';
  return 'ADMIN';
};

const inferAdminAction = (method, path) => {
  const verb = METHOD_VERB[method] || method;
  const cleaned = path
    .replace(/^\//, '')
    .split('/')
    .filter((s) => s && !/^\d+$/.test(s) && !/^[0-9a-f]{20,}$/i.test(s))
    .map((s) => s.replace(/[^a-z0-9]+/gi, '_').toUpperCase())
    .join('_');
  return `ADMIN_${cleaned}_${verb}`;
};

const autoLogAdminMutations = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  if (ADMIN_AUTO_LOG_SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const bodyCopy = req.body && typeof req.body === 'object' ? safeCloneBody(req.body) : req.body;

  res.on('finish', () => {
    try {
      if (req._auditedExplicitly) return;
      const success = res.statusCode >= 200 && res.statusCode < 400;

      const actor = resolveActor(req);
      auditService.logEvent({
        ...actor,
        action: inferAdminAction(req.method, req.path),
        category: inferAdminCategory(req.path),
        status: success ? 'SUCCESS' : 'FAILED',
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          params: req.params,
          query: req.query,
          body: bodyCopy,
        },
      });
    } catch {
      // swallow — never break the response path from a logging error
    }
  });

  next();
};

module.exports = {
  attachAuditLogger,
  resolveActor,
  autoLogAdminMutations,
  // Exported for unit tests / debugging
  _internal: { inferUserEvent, inferAdminAction, inferAdminCategory },
};
