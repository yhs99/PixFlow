const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const imageController = require('../controllers/imageController');

// 파일 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'public/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB 제한
    files: 10 // 최대 10개 파일
  }
});

// 이미지 업로드
router.post('/images', upload.array('images', 10), imageController.uploadImages);

// 이미지 목록 조회
router.get('/images', imageController.getImages);

// 그룹별 이미지 조회
router.get('/images/group/:groupId', imageController.getImagesByGroup);

// 이미지 삭제
router.delete('/images/:id', imageController.deleteImage);

module.exports = router; 