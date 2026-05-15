const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuthController = require('../controllers/adminAuthController');
const adminCommunity = require('../controllers/adminCommunityController');
const adminTag = require('../controllers/adminTagController');
const smtpController = require('../controllers/smtpController');
const golfSettingsController = require('../controllers/golfSettingsController');
const challengeController = require('../controllers/challengeController');
const announcementController = require('../controllers/announcementController');
const auditLogController = require('../controllers/auditLogController');
const platformSettingsController = require('../controllers/platformSettingsController');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuthMiddleware');
const { autoLogAdminMutations } = require('../middleware/auditMiddleware');

// ─── Admin Authentication (no auth required) ───────────────────────────────
router.post('/auth/login', adminAuthController.adminLogin);

// ─── Protected Admin Routes (auth required) ────────────────────────────────
router.use(authenticateAdmin); // All routes below require admin authentication
router.use(autoLogAdminMutations); // Auto-audit every non-GET admin request

// Admin profile
router.get('/auth/me', adminAuthController.getAdminMe);
router.post('/auth/change-password', adminAuthController.changeAdminPassword);
router.post('/auth/generate-view-token', adminAuthController.generateViewToken);

// GET /api/admin/dashboard-stats — dashboard overview statistics
router.get('/dashboard-stats', adminController.getDashboardStats);

// GET /api/admin/users — all users from DB
router.get('/users', adminController.getUsers);

// PATCH /api/admin/users/:userId/posting-block — toggle community
// posting/commenting block for a user (superadmin only).
router.patch('/users/:userId/posting-block', requireSuperAdmin, adminController.setUserPostingBlock);

// DELETE /api/admin/users/:userId — permanently delete user + all data (superadmin only)
router.delete('/users/:userId', requireSuperAdmin, adminController.deleteUser);

// POST /api/admin/sync-bags — fetch IYK data & insert new records
router.post('/sync-bags', adminController.syncBags);

// GET /api/admin/bag-types — all bag types from DB
router.get('/bag-types', adminController.getBagTypes);

// GET /api/admin/bag-types/:id/bags — all bags for a type
router.get('/bag-types/:id/bags', adminController.getBagsByType);

// ─── Community moderation ──────────────────────────────────────────────────
router.get('/posts', adminCommunity.listPosts);
router.patch('/posts/:id/hide', adminCommunity.toggleHide);
router.delete('/posts/:id', adminCommunity.deletePost);
router.get('/posts/:id/reports', adminCommunity.listReports);
router.patch('/posts/:id/reports/resolve', adminCommunity.resolveReports);

// User moderation
router.get('/users/:userId/moderation', adminCommunity.getUserModeration);
router.patch('/users/:userId/block-posting', adminCommunity.togglePostingBlock);

// Per-post tag override (admin manual tagging)
router.get('/posts/:id/tags', adminTag.getPostTags);
router.put('/posts/:id/tags', adminTag.setPostTags);

// ─── Tag & Keyword management ──────────────────────────────────────────────
router.get('/tags', adminTag.listTags);
router.post('/tags', adminTag.createTag);
router.patch('/tags/:id', adminTag.updateTag);
router.delete('/tags/:id', adminTag.deleteTag);
router.post('/tags/:id/keywords', adminTag.addKeyword);
router.delete('/keywords/:keywordId', adminTag.deleteKeyword);

// ─── SMTP Configuration ────────────────────────────────────────────────────
router.get('/smtp-config', smtpController.getSmtpConfig);
router.put('/smtp-config', smtpController.upsertSmtpConfig);
router.post('/smtp-config/test', smtpController.testSmtp);

// ─── H2H tournament bonus configuration ───────────────────────────────────
router.get('/h2h/tournaments/years', adminController.getTournamentYears);
router.get('/h2h/tournaments', adminController.listTournamentsH2H);
router.patch('/h2h/tournaments/:id', adminController.updateTournamentH2H);

// ─── Golf API Settings ─────────────────────────────────────────────────────
router.get('/golf-settings', golfSettingsController.getGolfSettings);
router.put('/golf-settings', golfSettingsController.updateGolfSettings);

// ─── Achievement Challenges ────────────────────────────────────────────────
router.get('/challenges', challengeController.adminListChallenges);
router.put('/challenges/:id', challengeController.adminUpdateChallenge);

// ─── Announcements ─────────────────────────────────────────────────────────
router.get('/announcements', announcementController.adminListAnnouncements);
router.post('/announcements', announcementController.adminCreateAnnouncement);
router.put('/announcements/:id', announcementController.adminUpdateAnnouncement);
router.delete('/announcements/:id', announcementController.adminDeleteAnnouncement);

// ─── Platform Settings ─────────────────────────────────────────────────────
// Read for any admin; writes + danger actions are superadmin-only.
router.get('/platform-settings', platformSettingsController.getSettings);
router.put('/platform-settings', requireSuperAdmin, platformSettingsController.updateSettings);
router.get('/danger/inactive-count', requireSuperAdmin, platformSettingsController.previewInactiveUsers);
router.post('/danger/reset-points', requireSuperAdmin, platformSettingsController.resetAllPoints);
router.post('/danger/purge-inactive', requireSuperAdmin, platformSettingsController.purgeInactiveUsers);

// ─── Audit Logs ────────────────────────────────────────────────────────────
// Read-only for any admin; settings + manual purge restricted to superadmin
// (retention controls retention for the whole platform).
router.get('/audit-logs', auditLogController.listAuditLogs);
router.get('/audit-logs/filters', auditLogController.getAuditLogFilters);
router.get('/audit-logs/export', auditLogController.exportAuditLogsCsv);
router.post('/audit-logs/purge', requireSuperAdmin, auditLogController.purgeAuditLogs);
router.get('/audit-settings', auditLogController.getAuditSettings);
router.put('/audit-settings', requireSuperAdmin, auditLogController.updateAuditSettings);

module.exports = router;
