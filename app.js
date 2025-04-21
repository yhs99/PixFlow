const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { logRequest, logImageUpload, logImageDelete, logImageUpdate, logImageList } = require('./middleware/logger');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
const port = 3000;

// 데이터베이스 설정
const db = new sqlite3.Database('gallery.db');

// 세션 설정
app.use(session({
  secret: 'stargroups',
  resave: false,
  saveUninitialized: false
}));

// Passport 초기화
app.use(passport.initialize());
app.use(passport.session());

// Discord OAuth 설정
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  // 사용자 정보를 데이터베이스에 저장
  db.run(`
    INSERT INTO users (id, displayName, avatar, last_updated)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      displayName = excluded.displayName,
      avatar = excluded.avatar,
      last_updated = CURRENT_TIMESTAMP
  `, [profile.id, profile.username, `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`], (err) => {
    if (err) {
      console.error('사용자 정보 저장 중 오류:', err);
      return done(err);
    }
    return done(null, profile);
  });
}));

// 세션 직렬화/역직렬화
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// 데이터베이스 테이블 생성 (없는 경우에만)
db.serialize(() => {
  // 테이블이 없을 경우에만 생성
  db.run(`CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    category TEXT
  )`);

  // userId 컬럼이 있는지 확인하고 없으면 추가
  db.all("PRAGMA table_info(images)", [], (err, columns) => {
    if (err) {
      console.error('테이블 정보 조회 중 오류:', err);
      return;
    }
    
    const hasUserId = columns && columns.some(col => col.name === 'userId');
    if (!hasUserId) {
      db.run('ALTER TABLE images ADD COLUMN userId TEXT');
      console.log('userId 컬럼이 추가되었습니다.');
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    displayName TEXT NOT NULL,
    avatar TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
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

// 로깅 미들웨어 적용
app.use(logRequest);

// 갤러리 페이지
app.get('/', (req, res) => {
  let selectedMonth = req.query.month || "";

  db.all(`
    SELECT 
      i.*,
      COALESCE(u.displayName, '') as displayName,
      COALESCE(u.avatar, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAOEAAADhCAMAAAAJbSJIAAAAflBMVEUAAAD////7+/v39/fy8vLf398VFRVycnKysrI6Ojqqqqrk5OQjIyNYWFi1tbUGBgYaGhpra2stLS3V1dU3NzcPDw/JycmUlJS9vb1NTU1gYGBCQkLt7e3Dw8OFhYUnJyd6enqNjY2cnJyIiIhQUFBmZmZ+fn5HR0ehoaHPz89TuizzAAAE90lEQVR4nO3d23aqMBAG4ABy9oAWD63aarXWvv8LbhHPJgMI7ElmzXe1L9hrzV/RQJgEYd1wIz/1BsJkAy/0I/c2lLj8y4nm2OU1Jo2c54RBF7usRnWDh4ROD7ukxvXs24Rxgl1PC5L4mjAeY1fTinF8TmhT/AQziXNKSO87eNbLEwbYdbQoyBI6tIaJe13nkDDCrqJV0SFhiF1Eq0JLuNg1tMwVtE/Sw2kqfOwSWuaLFLuEloXCwy6hZZ4w+4a3GPV8jDHGGGOMMcYYY4wxxhhjjDHG2CvS4XoaBbPlZDkLov308+MLu6IGhdPZwpJw+xsCvS6Jv3Rk6c4Ws6HR/S7v/Q4UL9fpv2PX+artW3G83JuRbcrpX9l8mT/zlrN8V8mX2WNXXE1S+gS9ckfYVVfwC/5+qtgf2HWXNnwlX2aFXXlJ/qsBTYnYez2gZZlwoqZ2nYS2AT83bnEMiP5rB6J6AS1rip2gwLxuQMvS/Laq5jmamWFnANUYKK60XqfUwEdoab3WrNZQeNHBjgGYFVff6RSPl/oO+4OC4uP1NhHj9OM7ho/rYwdR+oEL312P3IEHLvAiFOiDZd9dj8HXdtqunpfOGZ49DOTgj5K2SwaholePBwfAwd//v/ZSoK/h29PRKXC0rj81U6BmyQAATOU8/z30AJx3seRw4A+i64/pRF2y7EIMmM3R9aoGGMeHksNH5iUEnlFId08hlVB6vHkJF7YKlYQVJeQTAtdtuo6HFa3VCYlsCgQ8X9R9RrEc6P7JvMelMnt1QBu7tkZ0gY9wiV1cI4CLWI1noipYAwF1vbOoBHxKTOGXdA7NQ3WMbpLKjcCJtk/s8urzwFYw/R+RFuqCk44ERvsR3Myn60RieVv42Yb5dxUFj1AXxm/EuYYDWsZ2mp4VNWr8YBdYF3A7cbTCLrAuaNafRMCC56fmn6IJPEzYRrZ634HbvjvG/4oWdNV2tO4SKge8GF0QuGFaQwFdCpuMQh+h+deiAv4W/mEX1whgZk3vZsvSyAdUn6QkvoMC6NJwsCtrirKHgcTsdob4l1CId0VAm8Ay4NynIqGu7WvVqVZb/mIX1hhFZy2RjouMoguRzkmqGix2xf/TFIobCwMW4pWlSIhdVnPG8mcxsq5aQyXyhDTuC4+68oQT7Lqao2gGJvQZMsYYY4wRk4yovj/6wNst8ytwZ/JpfOeTRHo/G7WkM8128twrRGRZzEki2xAkJjRNk8jnaQi9EFzVSUNmokb11MK4rRKVlAGN2LqshI06IYGm7gy0CyaBlQcHYEsihdN0CwW0zG+5LGrOX2GX14AVmJDCAza491m2X4ZpoI12KCxyEuBuGZZDoHMW3gCMxuMnaL9P4xcg5NRN+jQuaYQIlQm32KU1RXX7RGHN9ol8wZPO25RW5j9fftsb7KKa9fU4Zkwo3FXc+4qubxOwAwKLgGTmm/1sMovW5i/iYowxxhhjjDHGGGOMMcYYY4wxxlpCYdtJyECQ6H8EeILMhmIKodD2paYN8QWp7jKJSFDp8VRxhd7vaq8ttAStJsgn0SEhoaWcz7rOISGxNcf3AitLSGJ5lVz2EsksoU11n4PjywqOa1hjbd/WXsv4uF9jvko3pvgpJvmGlKd1yATeLvGod+qev6y0DmgNGt3LBtvXteRORGKp3FF40zZ/t1rejfzQM/uWeOCFfnS3Dcc/nKgtTK/eWUsAAAAASUVORK5CYII=') as avatar
    FROM images i
    LEFT JOIN users u ON i.userId = u.id
    ORDER BY i.id DESC
  `, [], (err, images) => {
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
      selectedMonth,
      user: req.user
    });
  });
});

// 이미지 업로드 API
app.post('/api/images', upload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '이미지 파일이 필요합니다.' });
  }

  const { description, created_at, category, messageId, userId, displayName, avatar } = req.body;
  logImageUpload(req);
  
  const uploadedImages = [];
  let errorOccurred = false;

  // 트랜잭션 시작
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // 사용자 정보 업데이트 또는 삽입
    db.run(`
      INSERT INTO users (id, displayName, avatar, last_updated)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        displayName = excluded.displayName,
        avatar = excluded.avatar,
        last_updated = CURRENT_TIMESTAMP
    `, [userId, displayName, avatar], (err) => {
      if (err) {
        console.error('사용자 정보 업데이트 중 오류:', err);
        errorOccurred = true;
        return;
      }
    });

    req.files.forEach(file => {
      const filename = file.filename;
      db.run(
        'INSERT INTO images (filename, description, created_at, category, userId) VALUES (?, ?, ?, ?, ?)',
        [filename, description, created_at, category, userId],
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
  let query = `
    SELECT 
      i.*,
      u.displayName,
      u.avatar
    FROM images i
    LEFT JOIN users u ON i.userId = u.id
  `;
  let params = [];

  if (month) {
    query += ' WHERE strftime("%Y-%m", i.created_at) = ?';
    params.push(month);
  }

  query += ' ORDER BY i.created_at DESC';

  db.all(query, params, (err, images) => {
    console.log(images);
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 목록 조회 중 오류가 발생했습니다.' });
    }
    
    const imagesWithUrl = images.map(image => ({
      ...image,
      url: `/uploads/${image.filename}`,
      displayName: image.displayName || '',
      avatar: image.avatar || 'data:image/png;base64,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'
    }));
    
    logImageList(req, imagesWithUrl);
    res.json(imagesWithUrl);
  });
});

// 특정 이미지 조회 API
app.get('/api/images/:id', (req, res) => {
  const id = req.params.id;
  
  db.get(`
    SELECT 
      i.*,
      u.displayName,
      u.avatar
    FROM images i
    LEFT JOIN users u ON i.userId = u.id
    WHERE i.id = ?
  `, [id], (err, image) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 조회 중 오류가 발생했습니다.' });
    }
    
    if (!image) {
      return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
    }
    
    const imageWithUrl = {
      ...image,
      url: `/uploads/${image.filename}`,
      displayName: image.displayName || '',
      avatar: image.avatar || ''
    };
    
    logImageList(req, [imageWithUrl]);
    res.json(imageWithUrl);
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
        
        logImageDelete(req, { messageId, count: images.length });
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

      logImageUpdate(req, { id, description });
      res.json({ message: '설명이 성공적으로 수정되었습니다.' });
    }
  );
});

// 이미지 삭제 API (ID로)
app.delete('/api/images/:id', (req, res) => {
  const id = req.params.id;
  
  db.get('SELECT filename FROM images WHERE id = ?', [id], (err, image) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 조회 중 오류가 발생했습니다.' });
    }
    
    if (!image) {
      return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
    }
    
    // 데이터베이스에서 삭제
    db.run('DELETE FROM images WHERE id = ?', [id], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '이미지 삭제 중 오류가 발생했습니다.' });
      }
      
      // 파일 시스템에서 삭제
      const filePath = path.join('public/uploads', image.filename);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(err);
        }
        logImageDelete(req, { id, filename: image.filename });
        res.status(204).send();
      });
    });
  });
});

// Discord OAuth 라우트
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
  passport.authenticate('discord', {
    failureRedirect: '/'
  }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// 서버 시작
app.listen(port, '0.0.0.0');