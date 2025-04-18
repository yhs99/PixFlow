const express = require('express');
const router = express.Router();
const pageController = require('../controllers/pageController');

// 갤러리 페이지
router.get('/', pageController.renderGallery);

module.exports = router; 