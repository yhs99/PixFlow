const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('gallery.db');

console.log('데이터베이스 테이블 확인 중...');

db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
    if (err) {
        console.error('테이블 조회 중 오류 발생:', err);
        return;
    }
    console.log('테이블 목록:', tables);

    // images 테이블의 내용 확인
    db.all("SELECT * FROM images", [], (err, rows) => {
        if (err) {
            console.error('이미지 데이터 조회 중 오류 발생:', err);
            return;
        }
        console.log('이미지 데이터:', rows);
        db.close();
    });
}); 