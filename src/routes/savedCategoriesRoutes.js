const { Router } = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const savedPosts = require('../controllers/savedPostsController');

const router = Router();

router.get('/', authenticate, savedPosts.listCategories);
router.post('/', authenticate, savedPosts.createCategory);
router.patch('/:id', authenticate, savedPosts.updateCategory);
router.delete('/:id', authenticate, savedPosts.deleteCategory);

module.exports = router;
