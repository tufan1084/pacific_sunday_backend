const { Router } = require('express');
const { getProfile, getUserBags, getBagScans, getGolfPassport, updateGolfPassport, uploadProfilePhoto, updatePrivacy } = require('../controllers/profileController');
const { authenticate } = require('../middleware/authMiddleware');
const { uploadImage: upload } = require('../config/multerMemory');

const router = Router();

/**
 * GET /profile
 * Get authenticated user's profile data
 */
router.get('/', authenticate, getProfile);

/**
 * GET /profile/bags
 * Get all bags owned by authenticated user
 */
router.get('/bags', authenticate, getUserBags);

/**
 * GET /profile/bags/:bagId/scans
 * Get scan history for a specific bag
 */
router.get('/bags/:bagId/scans', authenticate, getBagScans);

/**
 * GET /profile/golf-passport
 * Get user's golf passport data
 */
router.get('/golf-passport', authenticate, getGolfPassport);

/**
 * PUT /profile/golf-passport
 * Update user's golf passport data
 */
router.put('/golf-passport', authenticate, updateGolfPassport);

/**
 * POST /profile/upload-photo
 * Upload profile photo
 */
router.post('/upload-photo', authenticate, upload.single('photo'), uploadProfilePhoto);

/**
 * PATCH /profile/privacy
 * Toggle profile privacy
 */
router.patch('/privacy', authenticate, updatePrivacy);

module.exports = router;
