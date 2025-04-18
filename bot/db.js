const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../gallery.db');

function isAllowedCommunity(parentId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.get(
      'SELECT id FROM allowed_communities WHERE id = ?',
      [parentId],
      (err, row) => {
        db.close();
        if (err) return reject(err);
        resolve(!!row); // row가 있으면 true, 없으면 false
      }
    );
  });
}

function addAllowedCommunity(parentId) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.run(
        'INSERT OR IGNORE INTO allowed_communities (id) VALUES (?)',
        [parentId],
        function (err) {
          db.close();
          if (err) return reject(err);
          resolve(this.changes > 0); // 추가됨: true / 이미 있음: false
        }
      );
    });
  }

module.exports = { isAllowedCommunity, addAllowedCommunity };
