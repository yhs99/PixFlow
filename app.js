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
const db = new sqlite3.Database('gallery.db', (err) => {
  if(err) {
    console.error('데이터베이스 연결 중 오류:', err);
  } else {
    console.log('데이터베이스 연결 성공');
  }
});
   // 프로세스 종료 시 데이터베이스 연결 닫기
process.on('exit', () => {
    db.close((err) => {
      if (err) {
        console.error('데이터베이스 닫기 오류:', err.message);
      } else {
        console.log('데이터베이스 연결이 안전하게 닫혔습니다.');
      }
    });
  });
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
  // 사용자의 길드 목록에서 특정 길드 멤버십 확인
  const isGuildMember = profile.guilds?.some(guild => guild.id === '1194296331376803981');
  
  // 사용자 정보를 데이터베이스에 저장
  console.log(profile);
  db.run(`
    INSERT INTO users (id, displayName, avatar, isGuildMember, last_updated)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      displayName = excluded.displayName,
      avatar = excluded.avatar,
      isGuildMember = excluded.isGuildMember,
      last_updated = CURRENT_TIMESTAMP
  `, [profile.id, profile.global_name, `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`, isGuildMember ? 1 : 0], (err) => {
    if (err) {
      console.error('사용자 정보 저장 중 오류:', err);
      return done(err);
    }
    return done(null, { ...profile, isGuildMember });
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
    isGuildMember BOOLEAN DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 댓글 테이블 생성
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imageId INTEGER NOT NULL,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    parentId INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (imageId) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (parentId) REFERENCES comments(id) ON DELETE CASCADE
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
    return res.status(400).json({ error: '이미지 파일을 선택해주세요! 📸' });
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
      INSERT INTO users (id, displayName, avatar, isGuildMember, last_updated)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
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
      return res.status(500).json({ error: '이미지 업로드 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
    }

    db.run('COMMIT', (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '이미지 업로드 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
      }
      
      res.status(201).json({
        message: `${uploadedImages.length}개의 이미지가 업로드 되었어요! ✨`,
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
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지 목록을 불러오는 중에 문제가 생겼어요. 새로고침 해주세요 🔄' });
    }
    
    const imagesWithUrl = images.map(image => ({
      ...image,
      url: `/uploads/${image.filename}`,
      displayName: image.displayName || '',
      avatar: image.avatar || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAOEAAADhCAMAAAAJbSJIAAAAdVBMVEV0f43///9we4p1gI5ve4lseIdMUlv7+/z09fZ4g5H4+Plia3eWnqiAipfj5ejp6+2DjZlSWWPX2t6hqLGNlqHLz9S9wshFSlKvtb3a3eC1u8LR1Nni5Oe7wMalrLWSmqVXX2leZ3I6PUNITVXFydA1OD0yNDqZenHNAAAKhklEQVR4nO2da3uyPAyGMRchCAS5yUVRW/b/f98L6pwHKKktlOe6cn/Zl3GIbZM0ScPLC4IgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCII0AOOS/1/Pa9QDIx4dfg6lRHz7HFKP/ANicuJkwg2S2LJSR+I6N7KsOPnKxHSI5OA3SC7dfBIF1pk3+Kvy+e9FQTSZt1NKbrsvyyi2rohc8NXu4vrCOFr2XLtVQjKbjvpr65459CX57uHadX9E7ZYsS27T1Ufw8Ir5IHrAW9wO4WXCfqxoC0aS0NEgLno/iZX4twrviQcjSmqWQAhze+Nu2dtZv+qUM0Zs2/E813X9nOyv5zm2TdjJaHqR4B7dcc81NFs5oa+Fs+uKTC7fO8y+w680SjrrbjfI6XbXnSRKv8Lv1Zvrex6vuMvilRpQrtxh48LFd0O06VT9U9DZVP1O2T+NmdOwjPZhU/laetkcGl2Q9qRh+XKWdnMC8jcDAlqWnKerBN0akbBDmxLQyBzNWTa0FHnPkICW1dA09au1e10s/CYEZK/GBLSsaQPuDXdL3dAGCOA7sqdxvgwKaFlfMpGDpzBkCv+QiBw8h0E1c6JuZcNWhgW0rFm9yoY+xiqaplurZ0PeTctn1ezZGLUUv8Q1Wgw7NC3dkXFt2yjumJbtTG37ffJjWrQz/ZoGkdumJbtQU2CqNUNY1yC2ZhXm1BILJ+1QpCdqUad+G2zhL3XYRLI0LdUNNTg2LfBIr9HvnbKZaZnu0B7PKE7xGSTRvBL50LRED2je7NtmozNFDPQajFaZijNapyn7Ni1OAd86dY2bmBanAK26xlymQoTGbBsZmxamkB99fo3fLn/mF31+TXm9i2F2uqZpC43hiS9dJpGKqoJMomuaFtTVtQVN09RuT3zmHk3xGredmjRnrScR1U5zf6KnQ0DJ8EW8Wc5Go2koqjcsIgqno9FsuZFz8bUEMxyZd91OqUMY54w47hKugrv/ub+X0alMOVKkI+ntSzzwk175+4RC44/j6zLZRj8lnqhhIbI9+Gnrl7s54+wgcy7e3Q0E4XDdNlK3F/BY/tp9eBrrVdegxsOHfR53wTN1rL4QPejWMCiKtLPq0o1D0UbWga7hBFotXw54Gc4Lt9xkWnHZd6HRZgfoY5UdNz4CPqlfotV8sSpelLyhA92SKjtuBFhpGT8uwvNPJHYYSmOC0NjXRHUhQq3hT6mH6IgqwstPDkFTXRtVi+gCl3z5HYTzvLz8hxPYg9eK8ShoZrsjeA4ttxixQE9A43uKZQvQKq/ySSqcpiKnCxr+2quFTaGKRpQJEtxDZK+h2S5FVWOnsMeI0iSs3CR+Cn4YaJ1nqrYL9jqwx4gcYIGqEc4wF/bojppXQ4FWSeRZCIKRwjOYFPboWGl7wauOlYEkLB9DoUMCHENL9lz8DeCtk6hISbAORdWw4KTsXklCaD2paJsm0KWiIAS4cuBdxVyAA4miVxXoY1EeF1yhpJSgEfqU14i8Q0FeZytwhcDxIanWBveAt78C90to1wTRQKiisRIVCeHB4HKdYfcFl5U7NfDEupLvDS9QSEqtkvAeQenYw884KhlEiUhimXtSURs+KdE1AhPzgEIgQ6ZOqCTTxV8qruPFdsavDtJd6D1vEKXyah+Fk4VWObbFR19pKvFkhVCNXLnesmDFA940LRDRlTqHq3BOiMnE1zMR70eR0wHgsg96Pwa+XDJItAerQLZqNvVvnkVsWEFjQm5sBqMfco/973mnBrrDvxBMLx0sOKHvYFuz/GvTQuhMtmxAYZf/RKXQejKknuN49ABom/FH8DM/XdabyJ/1V8hdPJfBDzqLRUe+ljHOL5P5VS6IwmBVEra1kOYWhbIaAlGF5hkozNJ/REKFWYoStgOUUAD5R3SpgqYRbc/bg0J1W4vOVIpQCLa16shhOaGChO06kVeGgucNDnmbRSHobbSdEJxXBQnNdzKBsHpewtYeQ7gF3Am2QMKqUOAF2XpZrfd8UUivAdOw1pTa4VOb11KC0AbXmaqUtsGi+p0eOXYz1XfALTl2LCVDUERDKaoPc0w3/BhHYu6wr2Mgg/7w2HU2uysouaewAc5wYemDvnN0DblN96naadM43Z/jbrYD84pfFcu+CAPNvTh0T2FEZtPV4NlTRN3B6tzimhM3BP1UCVcuEuYU5rrFoXcOlWZCHibyh9sXk8NvB29OPJh81lLLySd7CFQhfe5cwsEO3U0i6Fh2o8nur9V8dhfgrq0z1HR4jVOof7q5ar+dSemzWZgKQ6dxJw1nzL9qpE/oCFo8sHxIeDwPYVDzu55cp+bzIyKe7+xelz9plGzX527X620SpT/L153je/lJkqsrehNoYj1SX4HXcHcFnHJxwcThp5bl7qllef7n1LC8YAiAdbNWd+brbsLDgCdg3tV+WeCWNKR19Ba0WQr4bVWVm6Ci+ELmYmiR6AHuHSqNgHLfxuo9aTL36uvwyf29OC9fXnQCpiLzv91rX4C3MDoTucMaWqoIN6XbWS0L8JZMxtJfWUsPXKc00t5pQr4c5u+L12NQdnBGCu4U+wiLvd/chy6Ye0gL3kFTe9hCZZMeGv6QB3ced/USHwcS83AaLBiTpr9v8XIstpjdfsRIW6s/zm6n59TEN0qOMI+Hf26kxhbG5G+erkPumfwqEif+bnCaranOlj/+aX8RDHa++e935aGLTMiu1j7b3A0y8fbGZuc9+Te7FMKyRfB5e77ZdaKkTLRFN0QQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEGQnP8B5ReJrasbGCgAAAAASUVORK5CYII='
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
      return res.status(500).json({ error: '이미지를 불러오는 중에 문제가 생겼어요. 새로고침 해주세요 🔄' });
    }
    
    if (!image) {
      return res.status(404).json({ error: '앗! 이미지를 찾을 수 없어요 😅' });
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
      return res.status(500).json({ error: '이미지를 찾는 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
    }
    
    if (images.length === 0) {
      return res.status(404).json({ error: '앗! 해당 메시지의 이미지를 찾을 수 없어요 🤔' });
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
        return res.status(500).json({ error: '이미지 삭제 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
      }

      db.run('COMMIT', (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: '이미지 삭제 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
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
    return res.status(403).json({ error: '비밀번호가 틀렸어요! 다시 확인해주세요 🔒' });
  }

  db.run(
    'UPDATE images SET description = ? WHERE id = ?',
    [description, id],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '설명 수정 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: '앗! 이미지를 찾을 수 없어요 😅' });
      }

      logImageUpdate(req, { id, description });
      res.json({ message: '설명이 수정되었어요! ✨' });
    }
  );
});

// 이미지 삭제 API (ID로)
app.delete('/api/images/:id', (req, res) => {
  const id = req.params.id;
  
  db.get('SELECT filename FROM images WHERE id = ?', [id], (err, image) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '이미지를 찾는 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
    }
    
    if (!image) {
      return res.status(404).json({ error: '앗! 이미지를 찾을 수 없어요 😅' });
    }
    
    // 데이터베이스에서 삭제
    db.run('DELETE FROM images WHERE id = ?', [id], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '이미지 삭제 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
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

// 길드 멤버 확인 함수
async function isGuildMember(accessToken, userId) {
  try {
    console.log(`${accessToken} / ${userId} / ${process.env.DISCORD_BOT_TOKEN}`);
    const response = await fetch(`https://discord.com/api/v10/guilds/1194296331376803981/members/${userId}`, {
      headers: {
        'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`
      }
    });

    console.log(response);
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error('길드 멤버 확인 중 오류:', error);
    return false;
  }
}

// 댓글 작성 API
app.post('/api/comments', express.json(), async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: '로그인해야 작성할 수 있어요. 로그인 후 다시 시도해주세요 🔒' });
  }

  // DB에서 길드 멤버 여부 확인
  db.get('SELECT isGuildMember FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err) {
      console.error('사용자 정보 조회 중 오류:', err);
      return res.status(500).json({ error: '앗! 일시적인 오류가 발생했어요. 잠시 후에 다시 시도해주세요 😅' });
    }

    if (!user || !user.isGuildMember) {
      return res.status(403).json({ error: '별단 멤버가 아니신가요? 별단 멤버만 작성 가능해요 ✨' });
    }

    const { imageId, content, parentId } = req.body;
    
    if (!imageId || !content) {
      return res.status(400).json({ error: '댓글 내용이 없어요! 댓글 내용을 입력해주세요 📝' });
    }

    db.run(
      'INSERT INTO comments (imageId, userId, content, parentId) VALUES (?, ?, ?, ?)',
      [imageId, req.user.id, content, parentId || null],
      function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: '댓글 작성 중 문제가 생겼어요. 잠시 후에 다시 시도해주세요 🙏' });
        }

        res.status(201).json({
          id: this.lastID,
          message: '댓글이 작성되었어요! 🎉'
        });
      }
    );
  });
});

// 댓글 목록 조회 API
app.get('/api/comments/:imageId', (req, res) => {
  const imageId = req.params.imageId;

  db.all(`
    SELECT 
      c.*,
      u.displayName,
      u.avatar
    FROM comments c
    LEFT JOIN users u ON c.userId = u.id
    WHERE c.imageId = ?
    ORDER BY c.created_at ASC
  `, [imageId], (err, comments) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '댓글을 불러오는 중에 문제가 생겼어요. 새로고침 해주세요 🔄' });
    }

    // 댓글 계층 구조 생성
    const commentMap = {};
    const rootComments = [];

    comments.forEach(comment => {
      comment.replies = [];
      commentMap[comment.id] = comment;

      if (comment.parentId) {
        if (commentMap[comment.parentId]) {
          commentMap[comment.parentId].replies.push(comment);
        }
      } else {
        rootComments.push(comment);
      }
    });

    res.json(rootComments);
  });
});

// 댓글 삭제 API
app.delete('/api/comments/:id', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: '로그인해야 삭제할 수 있어요 🔒' });
  }

  const commentId = req.params.id;

  db.get('SELECT userId FROM comments WHERE id = ?', [commentId], (err, comment) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: '댓글 확인 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 😅' });
    }

    if (!comment) {
      return res.status(404).json({ error: '앗! 이미 삭제된 댓글이에요 🤔' });
    }

    if (comment.userId !== req.user.id) {
      return res.status(403).json({ error: '내가 작성한 댓글만 삭제할 수 있어요 ✋' });
    }

    db.run('DELETE FROM comments WHERE id = ?', [commentId], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: '댓글 삭제 중에 문제가 생겼어요. 잠시 후에 다시 시도해주세요 🙏' });
      }

      res.status(204).send();
    });
  });
});

// 서버 시작
app.listen(port, '0.0.0.0');