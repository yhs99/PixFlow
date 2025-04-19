const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// 데이터베이스 설정
const db = new sqlite3.Database('gallery.db');

// 데이터베이스 테이블 생성 (없는 경우에만)
db.serialize(() => {
  // 테이블이 없을 경우에만 생성
  db.run(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

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
    const messageId = req.body.messageId;
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${messageId}_${timestamp}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB 제한
    files: 10 // 최대 10개 파일
  }
});

// JSON 파싱 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 제공 (업로드된 이미지 접근용)
app.use(express.static('public'));

// EJS 템플릿 엔진 설정
app.set('view engine', 'ejs');
app.set('trust proxy', true);

// 갤러리 페이지
app.get('/', (req, res) => {
  let selectedMonth = req.query.month || "";

  db.all('SELECT * FROM images ORDER BY id DESC', [], (err, images) => {
    if (err) {
      console.error(err);
      return res.status(500).send('서버 오류가 발생했습니다.');
    }

    // 월별로 이미지 그룹화
    const groupedImages = {};
    const months = new Set();

    images.forEach(image => {
      if(image.category !== '' && image.category !== null) {
        months.add(image.category);
        if (!groupedImages[image.category]) {
          groupedImages[image.category] = [];
        }
        groupedImages[image.category].push(image);
      }else {
        const month = image.created_at.slice(0, 7);
        months.add(month);
      
        if (!groupedImages[month]) {
          groupedImages[month] = [];
        }
        groupedImages[month].push(image);
      }
    });
    if(selectedMonth === "" && months.size > 0) {
      selectedMonth = months.values().next().value;
    }
    res.render('gallery', { 
      groupedImages,
      months: Array.from(months).sort().reverse(),
      selectedMonth
    });
  });
});

// 이미지 업로드 API
app.post('/api/images', upload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '이미지 파일이 필요합니다.' });
  }

  const { description, created_at, category, messageId } = req.body;
  const uploadedImages = [];
  let errorOccurred = false;

  // 트랜잭션 시작
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    req.files.forEach(file => {
      const filename = file.filename;
      console.log(filename);
      db.run(
        'INSERT INTO images (filename, description, created_at, category) VALUES (?, ?, ?, ?)',
        [filename, description, created_at, category],
        function(err) {
          if (err) {
            console.error(err);
            errorOccurred = true;
            return;
          }
          
          uploadedImages.push({
            id: this.lastID,
            filename,
            description,
            url: `/uploads/${filename}`
          });
        }
      );
    });

    if (errorOccurred) {
      db.run('ROLLBACK');
      return res.status(500).json({ error: '이미지 업로드 중 오류가 발생했습니다.' });
    }

    db.run('COMMIT', (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '이미지 업로드 중 오류가 발생했습니다.' });
      }
      
      res.status(201).json({
        message: `${uploadedImages.length}개의 이미지가 성공적으로 업로드되었습니다.`,
        images: uploadedImages
      });
    });
  });
});

// 이미지 목록 조회 API
app.get('/api/images', (req, res) => {
  const month = req.query.month;
  let query = 'SELECT * FROM images';
  let params = [];

  if (month) {
    query += ' WHERE strftime("%Y-%m", created_at) = ?';
    params.push(month);
  }

  query += ' ORDER BY created_at DESC';

  db.all(query, params, (err, images) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 목록 조회 중 오류가 발생했습니다.' });
    }
    
    const imagesWithUrl = images.map(image => ({
      ...image,
      url: `/uploads/${image.filename}`
    }));
    
    res.json(imagesWithUrl);
  });
});

// 특정 이미지 조회 API
app.get('/api/images/:id', (req, res) => {
  const id = req.params.id;
  
  db.get('SELECT * FROM images WHERE id = ?', [id], (err, image) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 조회 중 오류가 발생했습니다.' });
    }
    
    if (!image) {
      return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
    }
    
    res.json({
      ...image,
      url: `/uploads/${image.filename}`
    });
  });
});

// 이미지 삭제 API (메시지 ID로)
app.delete('/api/images/message/:messageId', (req, res) => {
  const messageId = req.params.messageId;
  
  db.all('SELECT id, filename FROM images WHERE filename LIKE ?', [`${messageId}_%`], (err, images) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 조회 중 오류가 발생했습니다.' });
    }
    
    if (images.length === 0) {
      return res.status(404).json({ error: '해당 메시지의 이미지를 찾을 수 없습니다.' });
    }

    // 트랜잭션 시작
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      let errorOccurred = false;
      images.forEach(image => {
        // 데이터베이스에서 삭제
        db.run('DELETE FROM images WHERE id = ?', [image.id], (err) => {
          if (err) {
            console.error(err);
            errorOccurred = true;
            return;
          }
          
          // 파일 시스템에서 삭제
          const filePath = path.join('public/uploads', image.filename);
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(err);
              errorOccurred = true;
            }
          });
        });
      });

      if (errorOccurred) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: '이미지 삭제 중 오류가 발생했습니다.' });
      }

      db.run('COMMIT', (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: '이미지 삭제 중 오류가 발생했습니다.' });
        }
        
        res.status(204).send();
      });
    });
  });
});

// 이미지 설명 수정 API
app.put('/api/images/:id/description', express.json(), (req, res) => {
  const id = req.params.id;
  const { description, password } = req.body;

  if (password !== 'star') {
    return res.status(403).json({ error: '비밀번호가 올바르지 않습니다.' });
  }

  db.run(
    'UPDATE images SET description = ? WHERE id = ?',
    [description, id],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '설명 수정 중 오류가 발생했습니다.' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
      }

      res.json({ message: '설명이 성공적으로 수정되었습니다.' });
    }
  );
});

// 서버 시작
app.listen(port, '0.0.0.0');