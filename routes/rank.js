const express = require('express');
const router = express.Router();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./gallery.db');
const cron = require('node-cron');

// 한국 시간 포맷팅 함수 추가
function getKoreanDateTime() {
  const now = new Date();
  // 한국 시간으로 변환 (UTC+9)
  now.setHours(now.getHours() + 9);
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

// 데이터베이스 정규화 - 여러 테이블 생성
db.serialize(() => {
  // 기본 캐릭터 정보 테이블
  db.run(`CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    characterName TEXT UNIQUE,
    serverName TEXT,
    itemLevel REAL,
    className TEXT,
    characterLevel INTEGER,
    guildName TEXT,
    data TEXT,
    lopec INTEGER DEFAULT 0,
    specScore INTEGER DEFAULT 0,
    isGuildMember BOOLEAN DEFAULT 0,
    lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 기존 테이블에 specScore 컬럼이 없으면 추가
  db.all("PRAGMA table_info(characters)", [], (err, rows) => {
    if (err) {
      console.error('테이블 정보 조회 오류:', err);
      return;
    }
    
    // 컬럼 목록에서 specScore 찾기
    let hasSpecScore = false;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row.name === 'specScore') {
          hasSpecScore = true;
          break;
        }
      }
    }
    
    if (!hasSpecScore) {
      console.log('characters 테이블에 specScore 컬럼 추가');
      db.run("ALTER TABLE characters ADD COLUMN specScore INTEGER DEFAULT 0", err => {
        if (err) {
          console.error('specScore 컬럼 추가 오류:', err);
        } else {
          console.log('specScore 컬럼이 성공적으로 추가되었습니다.');
        }
      });
    } else {
      console.log('specScore 컬럼이 이미 존재합니다.');
    }
  });

  // CASCADE 옵션이 있는 테이블을 정의하는 함수
  function createTableWithCascade(tableName) {
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      characterName TEXT,
      data TEXT,
      lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (characterName) REFERENCES characters(characterName) ON DELETE CASCADE
    )`;
  }

  // 각 테이블의 CASCADE 제약조건 확인 및 적용
  const tables = [
    'equipment', 'avatars', 'combatSkills', 'engravings', 'cards', 
    'gems', 'colosseums', 'collectibles', 'arkpassive'
  ];

  // 모든 테이블에 대해 외래 키 제약조건 확인
  tables.forEach(tableName => {
    // 테이블이 존재하는지 확인
    db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName], (err, tableInfo) => {
      if (err) {
        console.error(`테이블 정보 조회 오류 (${tableName}):`, err);
        return;
      }

      if (tableInfo) {
        // 테이블이 존재하면 외래 키 제약조건 확인
        db.all(`PRAGMA foreign_key_list(${tableName})`, [], (err, foreignKeys) => {
          if (err) {
            console.error(`외래 키 정보 조회 오류 (${tableName}):`, err);
            return;
          }

          // CASCADE 제약조건이 있는지 확인
          const hasCascadeConstraint = foreignKeys && 
            foreignKeys.some(fk => 
              fk.table === 'characters' && 
              fk.from === 'characterName' && 
              fk.on_delete === 'CASCADE'
            );

          if (!hasCascadeConstraint) {
            console.log(`테이블 ${tableName}에 CASCADE 제약조건이 없습니다. 테이블을 재생성합니다.`);
            
            // 기존 테이블의 데이터 백업
            db.run(`ALTER TABLE ${tableName} RENAME TO ${tableName}_backup`, err => {
              if (err) {
                console.error(`테이블 ${tableName} 백업 중 오류:`, err);
                return;
              }

              // CASCADE 제약조건이 있는 새 테이블 생성
              db.run(createTableWithCascade(tableName), err => {
                if (err) {
                  console.error(`테이블 ${tableName} 재생성 중 오류:`, err);
                  return;
                }

                // 백업 테이블에서 데이터 복원
                db.run(`INSERT INTO ${tableName} (characterName, data, lastUpdated)
                        SELECT characterName, data, lastUpdated FROM ${tableName}_backup`, err => {
                  if (err) {
                    console.error(`테이블 ${tableName} 데이터 복원 중 오류:`, err);
                    return;
                  }

                  // 백업 테이블 삭제
                  db.run(`DROP TABLE ${tableName}_backup`, err => {
                    if (err) {
                      console.error(`테이블 ${tableName}_backup 삭제 중 오류:`, err);
                    } else {
                      console.log(`테이블 ${tableName}이 CASCADE 제약조건과 함께 성공적으로 재생성되었습니다.`);
                    }
                  });
                });
              });
            });
          } else {
            console.log(`테이블 ${tableName}에 이미 CASCADE 제약조건이 있습니다.`);
          }
        });
      } else {
        // 테이블이 없으면 처음부터 CASCADE 제약조건과 함께 생성
        db.run(createTableWithCascade(tableName), err => {
          if (err) {
            console.error(`테이블 ${tableName} 생성 중 오류:`, err);
          } else {
            console.log(`테이블 ${tableName}이 CASCADE 제약조건과 함께 생성되었습니다.`);
          }
        });
      }
    });
  });
});

// 별단 길드 이름 상수
const GUILD_NAME = '별단';
// API 요청 제한 시간 (5분 = 300,000ms)
const API_REQUEST_LIMIT = 300000;

// 인덱스 페이지 - 캐릭터 목록 및 검색 폼 표시
router.get('/', async (req, res) => {
  try {
    // 데이터베이스에서 별단 길드원 목록만 조회 (강함순(아이템레벨) 정렬)
    db.all(`SELECT * FROM characters 
            WHERE isGuildMember = 1 
            ORDER BY itemLevel DESC`, [], (err, characters) => {
      if (err) {
        console.error('데이터베이스 조회 오류:', err);
        return res.status(500).render('rank', { 
          characters: [], 
          error: '데이터를 불러오는데 실패했습니다.' 
        });
      }
      
      // 추가 정보 조회를 위한 Promise 배열
      const characterPromises = characters.map(character => {
        return new Promise((resolve, reject) => {
          // 장비 정보 조회
          db.get(`SELECT data FROM equipment WHERE characterName = ?`, [character.characterName], (err, equipmentData) => {
            if (err) return reject(err);
            
            // 각인 정보 조회
            db.get(`SELECT data FROM engravings WHERE characterName = ?`, [character.characterName], (err, engravingData) => {
              if (err) return reject(err);
              
              // 아크 패시브 정보 조회
              db.get(`SELECT data FROM arkpassive WHERE characterName = ?`, [character.characterName], (err, arkpassiveData) => {
                if (err) return reject(err);
                
                let weaponInfo = { level: 0, quality: 0, name: '' };
                let awakening = '';
                let engravings = [];
                let abilityStoneEngravings = [];
                
                // 무기 정보 추출
                if (equipmentData && equipmentData.data) {
                  try {
                    const equipmentJSON = JSON.parse(equipmentData.data);
                    const weapon = equipmentJSON.find(item => 
                      item.Type === '무기' || item.Type.includes('무기'));
                    
                    if (weapon) {
                      const levelMatch = weapon.Name.match(/\+(\d+)/);
                      const tooltipParsed = JSON.parse(weapon.Tooltip);
                      const weaponQuality = tooltipParsed.Element_001.value.qualityValue;
                      weaponInfo.level = levelMatch ? parseInt(levelMatch[1]) : 0;
                      weaponInfo.quality = weaponQuality || 0;
                      weaponInfo.name = weapon.Name;
                    }
                    
                    // 어빌리티 스톤 각인 정보 추출
                    const abilityStone = equipmentJSON.find(item => 
                      item.Type === '어빌리티 스톤' || item.Type.includes('스톤'));
                    if (abilityStone && abilityStone.ArmoryTooltip) {
                      try {
                        // 어빌리티 스톤 툴크에서 각인 효과 추출
                        if (typeof abilityStone.ArmoryTooltip === 'string') {
                          const tooltip = JSON.parse(abilityStone.ArmoryTooltip);
                          if (tooltip.Element_001 && tooltip.Element_001.Element_000) {
                            // 어빌리티 스톤 각인 정보 추출 로직
                            const engravingPattern = /<FONT COLOR='#[A-F0-9]+'>(.+?)<\/FONT>/g;
                            const tooltipText = tooltip.Element_001.Element_000.contentStr;
                            let match;
                            while ((match = engravingPattern.exec(tooltipText)) !== null) {
                              if (match[1].includes('+')) {
                                const parts = match[1].split('+');
                                if (parts.length === 2) {
                                  abilityStoneEngravings.push({
                                    name: parts[0].trim(),
                                    level: parseInt(parts[1])
                                  });
                                }
                              }
                            }
                          }
                        }
                      } catch (e) {
                        console.error('어빌리티 스톤 정보 파싱 오류:', e);
                      }
                    }
                  } catch (e) {
                    console.error('장비 데이터 파싱 오류:', e);
                  }
                }
                
                // 각인 정보 추출
                if (engravingData && engravingData.data) {
                  try {
                    const engravingJSON = JSON.parse(engravingData.data);
                    // 각인 효과 목록 추출
                    if (engravingJSON.ArkPassiveEffects) {
                      engravings = engravingJSON.ArkPassiveEffects.map(effect => {
                        return {
                          name: effect.Name,
                          level: effect.Level,
                          grade: effect.Grade,
                          description: effect.Description,
                          abilityStoneLevel: effect.AbilityStoneLevel || 0
                        };
                      });
                    }
                  } catch (e) {
                    console.error('각인 데이터 파싱 오류:', e);
                  }
                }
                
                // arkpassive 정보에서 아크 패시브 추출
                if (arkpassiveData && arkpassiveData.data && !awakening) {
                  try {
                    const arkpassiveJSON = JSON.parse(arkpassiveData.data);
                    // 아크 패시브 데이터 처리 (API 구조에 따라 수정 필요)
                    if (arkpassiveJSON.Effects) {
                      const tooltipParsed = JSON.parse(arkpassiveJSON.Effects[0].ToolTip);
                      if(tooltipParsed.Element_000?.value) {
                        awakening = tooltipParsed.Element_000.value;
                      }else {
                        awakening = '없음';
                      }
                    }
                  } catch (e) {
                    console.error('아크 패시브 데이터 파싱 오류:', e);
                  }
                }
                
                // 결과 객체 생성
                resolve({
                  id: character.id,
                  characterName: character.characterName,
                  serverName: character.serverName,
                  itemLevel: character.itemLevel,
                  className: character.className,
                  characterLevel: character.characterLevel,
                  guildName: character.guildName,
                  weapon: weaponInfo,
                  awakening: awakening,
                  engravings: engravings,
                  abilityStoneEngravings: abilityStoneEngravings
                });
              });
            });
          });
        });
      });
      
      // 모든 캐릭터 정보 처리 완료 후 응답
      Promise.all(characterPromises)
        .then(charactersWithDetails => {
          res.render('rank', { 
            characters: charactersWithDetails || [],
            error: null
          });
        })
        .catch(error => {
          console.error('캐릭터 상세 정보 조회 오류:', error);
          res.status(500).render('rank', { 
            characters: [], 
            error: '데이터를 불러오는데 실패했습니다.' 
          });
        });
    });
  } catch (error) {
    console.error('순위 페이지 로드 오류:', error);
    res.status(500).render('rank', { 
      characters: [], 
      error: '페이지를 불러오는데 실패했습니다.' 
    });
  }
});

// 마지막 업데이트 시간 확인 함수
async function shouldUpdateCharacter(characterName) {
  return new Promise((resolve, reject) => {
    // 기존 테이블 구조에 맞는 컬럼명 확인 (updatedAt 또는 lastUpdated)
    db.all(`PRAGMA table_info(characters)`, [], (err, columns) => {
      if (err) return reject(err);
      
      // 컬럼 목록을 확인하여 적절한 컬럼 이름 사용
      let timeColumn = 'lastUpdated'; // 기본값 변경
      
      // 컬럼 배열 처리
      if (Array.isArray(columns)) {
        const columnNames = columns.map(col => col.name || '');
        if (columnNames.includes('lastUpdated')) {
          timeColumn = 'lastUpdated';
        } else if (columnNames.includes('updatedAt')) {
          timeColumn = 'updatedAt';
        }
      } else {
        console.warn('PRAGMA 쿼리 결과가 배열이 아닙니다:', columns);
        // 객체로 반환된 경우 처리
        let columnNames = [];
        for (let key in columns) {
          if (columns[key] && columns[key].name) {
            columnNames.push(columns[key].name);
          }
        }
        
        if (columnNames.includes('lastUpdated')) {
          timeColumn = 'lastUpdated';
        } else if (columnNames.includes('updatedAt')) {
          timeColumn = 'updatedAt';
        }
      }
      
      // 캐릭터 조회
      db.get(`SELECT * FROM characters WHERE characterName = ?`, [characterName], (err, result) => {
        if (err) return reject(err);
        
        if (!result) {
          // 캐릭터 정보가 없으면 업데이트 필요
          return resolve({ needsUpdate: true, timeColumn });
        }
        
        // 마지막 업데이트 시간 확인
        const lastUpdateValue = result[timeColumn];
        
        if (!lastUpdateValue) {
          console.warn(`캐릭터 ${characterName}에 ${timeColumn} 값이 없습니다:`, result);
          return resolve({ needsUpdate: true, timeColumn }); // 값이 없으면 업데이트 필요
        }
        
        try {
          const lastUpdated = new Date(lastUpdateValue);
          const now = new Date();
          const diffTime = now - lastUpdated;
          
          console.log(`캐릭터 ${characterName} 마지막 업데이트: ${lastUpdated}, 현재: ${now}, 차이: ${diffTime}ms`);
          
          // 마지막 업데이트로부터 5분(300000ms) 이상 지났으면 업데이트 필요
          resolve({ needsUpdate: diffTime > API_REQUEST_LIMIT, timeColumn });
        } catch (e) {
          console.error(`날짜 변환 오류: ${lastUpdateValue}`, e);
          resolve({ needsUpdate: true, timeColumn }); // 오류가 있으면 업데이트 필요
        }
      });
    });
  });
}

// API 호출을 실행하고 결과를 DB에 저장하는 함수
async function fetchAndSaveCharacterData(characterName, apiKey) {
  try {
    // 업데이트 확인과 동시에 timeColumn 가져오기
    const updateCheck = await shouldUpdateCharacter(characterName);
    const timeColumn = updateCheck.timeColumn;
    
    console.log(`사용할 시간 컬럼명: ${timeColumn}`);
    
    // 먼저 characters 테이블이 존재하는지 확인
    const charactersTableExists = await new Promise((resolve, reject) => {
      db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='characters'`, [], (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      });
    });
    
    if (!charactersTableExists) {
      console.log('characters 테이블이 존재하지 않습니다. 테이블을 생성합니다.');
      await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS characters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          characterName TEXT UNIQUE,
          serverName TEXT,
          itemLevel REAL,
          className TEXT,
          characterLevel INTEGER,
          guildName TEXT,
          data TEXT,
          specScore INTEGER DEFAULT 0,
          isGuildMember BOOLEAN DEFAULT 0,
          ${timeColumn} DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, function(err) {
          if (err) {
            console.error('characters 테이블 생성 오류:', err);
            reject(err);
          } else {
            console.log('characters 테이블이 생성되었습니다.');
            resolve();
          }
        });
      });
    }
    
    // 외래 키 제약조건 활성화
    await new Promise((resolve, reject) => {
      db.run('PRAGMA foreign_keys = ON', err => {
        if (err) {
          console.error('외래 키 제약조건 활성화 오류:', err);
          reject(err);
        } else {
          console.log('외래 키 제약조건이 활성화되었습니다.');
          resolve();
        }
      });
    });
    
    // 단일 API 요청으로 모든 데이터 가져오기
    console.log(`캐릭터 정보 가져오기: ${characterName}`);
    const apiUrl = `https://developer-lostark.game.onstove.com/armories/characters/${encodeURIComponent(characterName)}`;
    console.log(`API 요청: ${apiUrl}`);
    
    // 메인 API 요청 실행
    const armoryResponse = await axios.get(apiUrl, {
      headers: {
        'accept': 'application/json',
        'authorization': `bearer ${apiKey}`
      }
    });
    
    console.log('API 응답 성공 (캐릭터 아머리)');
    
    if (!armoryResponse.data) {
      console.error('캐릭터 정보를 가져오는데 실패했습니다.');
      throw new Error('API 응답이 없습니다.');
    }
    // 아머리 데이터에서 필요한 정보 추출
    const armoryData = armoryResponse.data;
    
    // 각 데이터 매핑
    const dataMap = {
      characters: armoryData.ArmoryProfile,
      equipment: armoryData.ArmoryEquipment,
      avatars: armoryData.ArmoryAvatars,
      combatSkills: armoryData.ArmorySkills,
      engravings: armoryData.ArmoryEngraving,
      cards: armoryData.ArmoryCard,
      gems: armoryData.ArmoryGem,
      colosseums: armoryData.ColosseumInfo,
      collectibles: armoryData.Collectibles,
      arkpassive: armoryData.ArkPassive
    };
    
    // 프로필 정보 처리
    const profileData = dataMap.characters;
    if (!profileData || !profileData.CharacterName) {
      console.error('캐릭터 프로필 정보가 유효하지 않습니다.');
      throw new Error('API 응답에 캐릭터 이름이 없습니다.');
    }
    
    let itemLevel = 0;
    if (profileData.ItemAvgLevel) {
      // 쉼표 제거 후 숫자로 변환
      itemLevel = parseFloat(profileData.ItemAvgLevel.replace(/,/g, ''));
      if (isNaN(itemLevel)) {
        console.warn(`유효하지 않은 아이템 레벨: ${profileData.ItemAvgLevel}, 0으로 설정합니다.`);
        itemLevel = 0;
      }
    } else {
      console.warn('아이템 레벨 정보가 없습니다. 0으로 설정합니다.');
    }
    
    const serverName = profileData.ServerName || '알 수 없음';
    const characterClassName = profileData.CharacterClassName || '알 수 없음';
    const characterLevel = profileData.CharacterLevel || 0;
    const guildName = profileData.GuildName || '';
    const isGuildMember = guildName === GUILD_NAME;
    
    console.log(`캐릭터 정보: ${characterName}, 서버: ${serverName}, 클래스: ${characterClassName}, 레벨: ${characterLevel}, 아이템 레벨: ${itemLevel}, 길드: ${guildName}`);
    
    // 길드원이 아닐 경우 데이터 저장하지 않음\
    console.log(toNumber(profileData.ItemAvgLevel));
    if (!isGuildMember || toNumber(profileData.ItemAvgLevel) < 1640) {
      console.log(`${characterName}는 저장 조건이 아닙니다.`);
      return {
        success: false, 
        isGuildMember: false, 
        characterName
      };
    }
    
    // 트랜잭션 상태 확인 변수 추가
    let inTransaction = false;
    
    try {
      // 데이터베이스에 캐릭터 정보 저장
      await new Promise((resolve, reject) => {
        // 트랜잭션 시작
        db.get('SELECT sqlite_version()', [], (err, result) => {
          if (err) {
            console.error('SQLite 버전 확인 오류:', err);
            return reject(err);
          }
          
          db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
              // 이미 트랜잭션이 시작된 경우 무시하고 계속 진행
              if (err.message && err.message.includes('cannot start a transaction within a transaction')) {
                console.warn('이미 트랜잭션이 진행 중입니다. 새 트랜잭션 시작을 건너뜁니다.');
                inTransaction = true;
                return resolve();
              }
              console.error('트랜잭션 시작 오류:', err);
              return reject(err);
            }
            
            inTransaction = true;
            resolve();
          });
        });
      });
      
      // 적절한 컬럼명 사용
      console.log(`characters 테이블에 데이터 삽입 시도: ${characterName}`);
      const koreanDateTime = getKoreanDateTime();
      const query = `INSERT OR REPLACE INTO characters 
                    (characterName, serverName, itemLevel, className, characterLevel, guildName, data, isGuildMember, ${timeColumn}) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      
      await new Promise((resolve, reject) => {
        db.run(query,
          [
            characterName,
            serverName,
            itemLevel,
            characterClassName,
            characterLevel,
            guildName,
            JSON.stringify(profileData),
            isGuildMember ? 1 : 0,
            koreanDateTime
          ],
          function(err) {
            if (err) {
              console.error('캐릭터 데이터 삽입 오류:', err);
              reject(err);
            } else {
              console.log(`캐릭터 데이터 삽입 성공: ${characterName}, rowid: ${this.lastID}`);
              resolve();
            }
          }
        );
      });
      
      // 테이블 매핑 정보
      const tables = [
        { name: 'equipment', data: dataMap.equipment },
        { name: 'avatars', data: dataMap.avatars },
        { name: 'combatSkills', data: dataMap.combatSkills },
        { name: 'engravings', data: dataMap.engravings },
        { name: 'cards', data: dataMap.cards },
        { name: 'gems', data: dataMap.gems },
        { name: 'colosseums', data: dataMap.colosseums },
        { name: 'collectibles', data: dataMap.collectibles },
        { name: 'arkpassive', data: dataMap.arkpassive }
      ];
      
      // 각 테이블에 데이터 저장
      for (const table of tables) {
        if (!table.data) continue; // 데이터가 없으면 저장하지 않음
        
        // 테이블이 존재하는지 먼저 확인
        const tableExists = await new Promise((resolve, reject) => {
          db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table.name], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
          });
        });
        
        // 테이블이 없으면 생성
        if (!tableExists) {
          console.log(`테이블 '${table.name}'이 존재하지 않습니다. 테이블을 생성합니다.`);
          
          // 중요: CASCADE 제약조건이 있는 테이블 생성
          await new Promise((resolve, reject) => {
            db.run(`CREATE TABLE IF NOT EXISTS ${table.name} (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              characterName TEXT,
              data TEXT,
              ${timeColumn} DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (characterName) REFERENCES characters(characterName) ON DELETE CASCADE
            )`, function(err) {
              if (err) {
                console.error(`테이블 ${table.name} 생성 오류:`, err);
                reject(err);
              } else {
                console.log(`테이블 ${table.name}이 CASCADE 제약조건과 함께 생성되었습니다.`);
                resolve();
              }
            });
          });
        } else {
          // 테이블이 있으면 외래 키 제약조건 확인
          const foreignKeys = await new Promise((resolve, reject) => {
            db.all(`PRAGMA foreign_key_list(${table.name})`, [], (err, keys) => {
              if (err) return reject(err);
              resolve(keys || []);
            });
          });
          
          // CASCADE 제약조건이 있는지 확인
          const hasCascadeConstraint = foreignKeys.some(fk => 
            fk.table === 'characters' && 
            fk.from === 'characterName' && 
            fk.on_delete === 'CASCADE'
          );
          
          if (!hasCascadeConstraint) {
            console.log(`테이블 ${table.name}에 CASCADE 제약조건이 없지만, 이미 존재하는 테이블입니다. 초기화 시 재생성될 예정입니다.`);
          }
        }
        
        // 데이터 저장
        await new Promise((resolve, reject) => {
          const koreanDateTime = getKoreanDateTime();
          const query = `INSERT OR REPLACE INTO ${table.name} 
                        (characterName, data, ${timeColumn}) 
                        VALUES (?, ?, ?)`;
          
          db.run(query,
            [
              characterName,
              JSON.stringify(table.data),
              koreanDateTime
            ],
            function(err) {
              if (err) {
                console.error(`데이터 저장 오류 (${table.name}):`, err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        }).catch(err => {
          console.warn(`${table.name} 테이블에 데이터 저장 실패, 계속 진행합니다:`, err);
        });
      }
      
      // 트랜잭션이 시작된 경우에만 커밋
      if (inTransaction) {
        await new Promise((resolve, reject) => {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              console.error('트랜잭션 커밋 오류:', commitErr);
              db.run('ROLLBACK', () => reject(commitErr));
            } else {
              console.log(`${characterName} 데이터 저장 트랜잭션 커밋 완료`);
              resolve();
            }
          });
        });
      }
      
      return { success: true, isGuildMember, characterName };
    } catch (error) {
      // 오류 발생 시 트랜잭션이 시작된 경우에만 롤백
      if (inTransaction) {
        await new Promise(resolve => {
          db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) {
              console.error('트랜잭션 롤백 오류:', rollbackErr);
            } else {
              console.log(`${characterName} 데이터 저장 실패로 롤백 완료`);
            }
            resolve();
          });
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('API 데이터 처리 오류:', error);
    throw error;
  }
}

// 형제 캐릭터 정보를 처리하는 함수
async function fetchSiblingCharacters(siblings, apiKey, dbTimeColumn) {
  if (!Array.isArray(siblings) || siblings.length === 0) {
    console.log('처리할 형제 캐릭터가 없습니다.');
    return [];
  }

  console.log(`${siblings.length}명의 형제 캐릭터 정보를 처리합니다.`);
  
  // 길드원인 형제 캐릭터 이름을 저장할 배열
  const guildMemberSiblings = [];
  
  // 각 형제 캐릭터에 대해 API 호출 (동시에 너무 많은 요청을 보내지 않도록 순차적으로 처리)
  for (const sibling of siblings) {
    if (!sibling.CharacterName || sibling.ServerName !== '카제로스') {
      console.log('서버가 카제로스가 아닙니다. 건너뜁니다.');
      continue;
    }

    const siblingName = sibling.CharacterName;
    
    // 이미 DB에 존재하고 최근에 업데이트되었는지 확인
    const updateCheck = await shouldUpdateCharacter(siblingName);
    const needsUpdate = updateCheck.needsUpdate;
    // 데이터베이스 시간 컬럼은 함수에서 전달받은 값 사용
    
    if (!needsUpdate) {
      console.log(`형제 캐릭터 ${siblingName}은(는) 최근에 업데이트되었습니다. 건너뜁니다.`);
      
      // 기존 데이터에서 길드원인지 확인
      const existingSibling = await new Promise((resolve) => {
        db.get(`SELECT isGuildMember FROM characters WHERE characterName = ?`, [siblingName], (err, row) => {
          if (err || !row) resolve(null);
          else resolve(row);
        });
      });
      
      if (existingSibling && existingSibling.isGuildMember) {
        guildMemberSiblings.push(siblingName);
      }
      
      continue;
    }
    
    // API 호출 및 데이터 저장
    try {
      const result = await fetchAndSaveCharacterData(siblingName, apiKey);
      
      if (result.success && result.isGuildMember) {
        guildMemberSiblings.push(siblingName);
      }
    } catch (error) {
      console.error(`형제 캐릭터 ${siblingName} 처리 중 오류 발생:`, error);
    }
    
    // 1초 대기
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return guildMemberSiblings;
}

// Server-Sent Events를 사용한 캐릭터 검색 (GET 요청 처리)
router.get('/search', async (req, res) => {
  const characterName = req.query.characterName;
  const includeSiblings = req.query.includeSiblings === 'on';
  
  if (!characterName) {
    return res.status(400).json({ 
      error: '캐릭터 이름이 필요합니다.' 
    });
  }

  try {
    // SSE 설정 - 클라이언트에 진행 상황을 전송하기 위한 헤더 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 진행 상황 전송 함수
    const sendProgress = (stage, message, percentage = 0) => {
      res.write(`data: ${JSON.stringify({ stage, message, percentage })}\n\n`);
    };

    // 초기 진행 상황 전송
    sendProgress('start', '캐릭터 검색을 시작합니다...', 5);

    // 마지막 업데이트 시간 확인
    const updateCheck = await shouldUpdateCharacter(characterName);
    const needsUpdate = updateCheck.needsUpdate;
    
    if (!needsUpdate) {
      sendProgress('checking', '최근에 업데이트된 정보가 있습니다.', 20);
      console.log(`${characterName} 정보는 최근 5분 이내에 업데이트되었습니다. API 요청을 생략합니다.`);
      
      // 캐릭터가 길드원인지 확인
      db.get(`SELECT isGuildMember FROM characters WHERE characterName = ?`, [characterName], (err, character) => {
        if (err || !character) {
          sendProgress('error', '캐릭터 정보를 찾을 수 없습니다.', 100);
          res.end();
          return;
        }
        
        if (!character.isGuildMember) {
          sendProgress('error', `'${characterName}'님은 별단 길드원이 아닙니다.`, 100);
          res.end();
          return;
        }
        
        // 길드원이면 완료 메시지 전송
        sendProgress('complete', '데이터 로드 완료! 페이지를 갱신합니다.', 100);
        res.end();
      });
      return;
    }
    
    // API 키 가져오기
    const apiKey = process.env.LOSTARK_API_KEY || 'YOUR_API_KEY';
    
    sendProgress('api_request', '로스트아크 API에서 캐릭터 정보를 가져오는 중...', 30);
    
    // API 호출 및 데이터 저장
    const result = await fetchAndSaveCharacterData(characterName, apiKey);
    
    if (!result.success) {
      // API 호출 실패
      sendProgress('error', '캐릭터 정보를 가져오는데 실패했습니다.', 100);
      res.end();
      return;
    }
    
    if (!result.isGuildMember) {
      sendProgress('error', `'${characterName}'님은 별단 길드원이 아닙니다.`, 100);
      res.end();
      return;
    }

    sendProgress('character_saved', '캐릭터 정보 저장 완료!', 50);
    
    // 원정대 포함 옵션이 선택된 경우에만 형제 캐릭터 처리
    if (includeSiblings) {
      sendProgress('siblings', '원정대 캐릭터 정보를 가져오는 중...', 60);
      
      const siblingsUrl = `https://developer-lostark.game.onstove.com/characters/${encodeURIComponent(characterName)}/siblings`;
      
      try {
        const siblingsResponse = await axios.get(siblingsUrl, {
          headers: {
            'accept': 'application/json',
            'authorization': `bearer ${apiKey}`
          }
        });
        
        if (siblingsResponse.data) {
          const siblings = siblingsResponse.data;
          sendProgress('siblings_processing', `${siblings.length}개의 원정대 캐릭터 처리 중...`, 70);
          
          // 전체 원정대 캐릭터 수
          const totalSiblings = siblings.length;
          let processedCount = 0;
          let guildMemberSiblings = [];
          
          // 형제 캐릭터 순차적 처리 - Promise.all 대신 for 루프 사용
          for (const sibling of siblings) {
            const siblingName = sibling.CharacterName;
            
            // 서버 확인
            if (!siblingName || sibling.ServerName !== '카제로스') {
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 서버가 카제로스가 아닙니다.`, percentage);
              continue;
            }
            
            // 이미 DB에 존재하고 최근에 업데이트되었는지 확인
            const siblingUpdateCheck = await shouldUpdateCharacter(siblingName);
            const needsSiblingUpdate = siblingUpdateCheck.needsUpdate;
            
            if (!needsSiblingUpdate) {
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 최근에 업데이트됨`, percentage);
              
              // 기존 데이터에서 길드원인지 확인
              const existingSibling = await new Promise((resolve) => {
                db.get(`SELECT isGuildMember FROM characters WHERE characterName = ?`, [siblingName], (err, row) => {
                  if (err || !row) resolve(null);
                  else resolve(row);
                });
              });
              
              if (existingSibling && existingSibling.isGuildMember) {
                guildMemberSiblings.push(siblingName);
              }
              
              continue;
            }
            
            try {
              // API 호출 및 데이터 저장 - 한 번에 하나의 캐릭터만 처리
              const siblingResult = await fetchAndSaveCharacterData(siblingName, apiKey);
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              
              if (siblingResult.success && siblingResult.isGuildMember) {
                sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 길드원 확인됨`, percentage);
                guildMemberSiblings.push(siblingName);
              } else {
                sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 길드원이 아님`, percentage);
              }
            } catch (error) {
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 오류 발생`, percentage);
              console.error(`형제 캐릭터 ${siblingName} 처리 중 오류 발생:`, error);
            }
            
            // 각 캐릭터 처리 후 1초 대기
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          if (guildMemberSiblings.length > 0) {
            sendProgress('siblings_complete', `${guildMemberSiblings.length}명의 길드원 캐릭터가 발견되었습니다.`, 90);
            console.log(`${characterName}님의 형제 캐릭터 중 별단 길드원:`, guildMemberSiblings);
          } else {
            sendProgress('siblings_complete', '원정대에 추가 길드원이 없습니다.', 90);
          }
        }
      } catch (error) {
        console.error('원정대 정보 조회 오류:', error);
        sendProgress('siblings_error', '원정대 정보를 가져오는데 실패했습니다.', 90);
      }
    }
    
    // 완료 메시지 전송
    sendProgress('complete', '데이터 로드 완료! 페이지를 갱신합니다.', 100);
    res.end();
  } catch (error) {
    console.error('API 요청 오류:', error.response?.data || error.message);
    
    // 오류 메시지 전송
    res.write(`data: ${JSON.stringify({ 
      stage: 'error', 
      message: '오류가 발생했습니다: ' + (error.message || '알 수 없는 오류'),
      percentage: 100
    })}\n\n`);
    res.end();
  }
});

// 캐릭터 검색 및 추가 (POST 요청 처리)
router.post('/search', async (req, res) => {
  const characterName = req.body.characterName;
  const includeSiblings = req.body.includeSiblings === 'on';
  
  if (!characterName) {
    return res.status(400).render('rank', { 
      characters: [], 
      error: '캐릭터 이름을 입력해주세요.' 
    });
  }

  try {
    // 마지막 업데이트 시간 확인
    const updateCheck = await shouldUpdateCharacter(characterName);
    const needsUpdate = updateCheck.needsUpdate;
    
    if (!needsUpdate) {
      console.log(`${characterName} 정보는 최근 5분 이내에 업데이트되었습니다. API 요청을 생략합니다.`);
      
      // 캐릭터가 길드원인지 확인
      db.get(`SELECT isGuildMember FROM characters WHERE characterName = ?`, [characterName], (err, character) => {
        if (err || !character) {
          return res.status(404).render('rank', { 
            characters: [], 
            error: '캐릭터 정보를 찾을 수 없습니다.' 
          });
        }
        
        if (!character.isGuildMember) {
          return res.status(403).render('rank', {
            characters: [],
            error: `'${characterName}'님은 별단 길드원이 아닙니다. 별단 길드원만 순위표에 추가할 수 있습니다.`
          });
        }
        
        // 길드원이면 순위 페이지로 리다이렉트
        res.redirect('/rank');
      });
      return;
    }
    
    // API 키 가져오기
    const apiKey = process.env.LOSTARK_API_KEY || 'YOUR_API_KEY';
    
    // API 호출 및 데이터 저장
    const result = await fetchAndSaveCharacterData(characterName, apiKey);
    
    if (!result.success) {
      // API 호출 실패
      return res.status(500).render('rank', { 
        characters: [], 
        error: '캐릭터 정보를 가져오는데 실패했습니다.' 
      });
    }
    
    if (!result.isGuildMember) {
      // 길드원이 아닐 경우
      db.all(`SELECT * FROM characters 
              WHERE isGuildMember = 1 
              ORDER BY itemLevel DESC`, [], (err, characters) => {
        return res.status(403).render('rank', {
          characters: characters || [],
          error: `'${characterName}'님은 별단 길드원이 아닙니다. 별단 길드원만 순위표에 추가할 수 있습니다.`
        });
      });
      return;
    }
    
    // 원정대 포함 옵션이 선택된 경우에만 형제 캐릭터 처리
    if (includeSiblings) {
      const siblingsUrl = `https://developer-lostark.game.onstove.com/characters/${encodeURIComponent(characterName)}/siblings`;
      const siblingsResponse = await axios.get(siblingsUrl, {
        headers: {
          'accept': 'application/json',
          'authorization': `bearer ${apiKey}`
        }
      });
      
      if (siblingsResponse.data) {
        const siblings = siblingsResponse.data;
        console.log(`${siblings.length}명의 원정대 캐릭터 정보를 처리합니다.`);
        
        // 길드원인 형제 캐릭터 이름을 저장할 배열
        const guildMemberSiblings = [];
        
        // 각 형제 캐릭터에 대해 API 호출 (동시에 너무 많은 요청을 보내지 않도록 순차적으로 처리)
        for (const sibling of siblings) {
          if (!sibling.CharacterName || sibling.ServerName !== '카제로스') {
            console.log('서버가 카제로스가 아닙니다. 건너뜁니다.');
            continue;
          }

          const siblingName = sibling.CharacterName;
          
          // 이미 DB에 존재하고 최근에 업데이트되었는지 확인
          const siblingUpdateCheck = await shouldUpdateCharacter(siblingName);
          const needsSiblingUpdate = siblingUpdateCheck.needsUpdate;
          
          if (!needsSiblingUpdate) {
            console.log(`형제 캐릭터 ${siblingName}은(는) 최근에 업데이트되었습니다. 건너뜁니다.`);
            
            // 기존 데이터에서 길드원인지 확인
            const existingSibling = await new Promise((resolve) => {
              db.get(`SELECT isGuildMember FROM characters WHERE characterName = ?`, [siblingName], (err, row) => {
                if (err || !row) resolve(null);
                else resolve(row);
              });
            });
            
            if (existingSibling && existingSibling.isGuildMember) {
              guildMemberSiblings.push(siblingName);
            }
            
            continue;
          }
          
          // API 호출 및 데이터 저장
          try {
            const siblingResult = await fetchAndSaveCharacterData(siblingName, apiKey);
            
            if (siblingResult.success && siblingResult.isGuildMember) {
              guildMemberSiblings.push(siblingName);
            }
          } catch (error) {
            console.error(`형제 캐릭터 ${siblingName} 처리 중 오류 발생:`, error);
          }
          
          // 1초 대기
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        if (guildMemberSiblings.length > 0) {
          console.log(`${characterName}님의 형제 캐릭터 중 별단 길드원:`, guildMemberSiblings);
        }
      }
    }
    
    // 검색 성공 시 순위 페이지로 리다이렉트
    res.redirect('/rank');
    
  } catch (error) {
    console.error('API 요청 오류:', error.response?.data || error.message);
    
    // API 오류 시 DB에서 기존 데이터 조회
    db.get(`SELECT * FROM characters WHERE characterName = ?`, [characterName], (err, character) => {
      if (err || !character) {
        db.all(`SELECT * FROM characters 
                WHERE isGuildMember = 1 
                ORDER BY itemLevel DESC`, [], (err, characters) => {
          return res.status(500).render('rank', { 
            characters: characters || [],
            error: '캐릭터 정보를 가져오는데 실패했습니다.' 
          });
        });
        return;
      }
      
      // 캐릭터가 길드원인지 확인
      if (!character.isGuildMember) {
        db.all(`SELECT * FROM characters 
                WHERE isGuildMember = 1 
                ORDER BY itemLevel DESC`, [], (err, characters) => {
          return res.status(403).render('rank', {
            characters: characters || [],
            error: `'${characterName}'님은 별단 길드원이 아닙니다. 별단 길드원만 순위표에 추가할 수 있습니다.`
          });
        });
        return;
      }
      
      // 기존 데이터가 있으면 순위 페이지로 리다이렉트
      res.redirect('/rank');
    });
  }
});

// 캐릭터 삭제 API
router.delete('/api/character/:name', async (req, res) => {
  const characterName = req.params.name;
  
  if (!characterName) {
    return res.status(400).json({ 
      success: false, 
      message: '캐릭터 이름이 필요합니다.' 
    });
  }

  try {
    // 외래 키 제약조건 활성화 확인
    await new Promise((resolve, reject) => {
      db.run('PRAGMA foreign_keys = ON', err => {
        if (err) {
          console.error('외래 키 제약조건 활성화 오류:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
    
    // 캐릭터 존재 여부 확인
    const character = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM characters WHERE characterName = ?`, [characterName], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    
    if (!character) {
      return res.status(404).json({ 
        success: false, 
        message: '캐릭터를 찾을 수 없습니다.' 
      });
    }
    
    // 트랜잭션 시작
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);
        resolve();
      });
    });
    
    try {
      // 캐릭터 삭제 (관련 테이블은 CASCADE로 자동 삭제됨)
      await new Promise((resolve, reject) => {
        db.run(`DELETE FROM characters WHERE characterName = ?`, [characterName], function(err) {
          if (err) return reject(err);
          console.log(`캐릭터 삭제됨: ${characterName}, 영향받은 행: ${this.changes}`);
          resolve(this.changes);
        });
      });
      
      // 트랜잭션 커밋
      await new Promise((resolve, reject) => {
        db.run('COMMIT', err => {
          if (err) return reject(err);
          resolve();
        });
      });
      
      res.json({ 
        success: true, 
        message: `캐릭터 '${characterName}'이(가) 성공적으로 삭제되었습니다.` 
      });
    } catch (err) {
      // 오류 발생 시 롤백
      await new Promise((resolve, reject) => {
        db.run('ROLLBACK', rollbackErr => {
          if (rollbackErr) console.error('롤백 오류:', rollbackErr);
          resolve();
        });
      });
      throw err;
    }
  } catch (error) {
    console.error('캐릭터 삭제 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '캐릭터 삭제 중 오류가 발생했습니다.' 
    });
  }
});

// 캐릭터 삭제 UI 라우트 (POST 방식으로 처리)
router.post('/delete/:name', async (req, res) => {
  const characterName = req.params.name;
  
  if (!characterName) {
    return res.status(400).render('rank', { 
      characters: [], 
      error: '캐릭터 이름이 필요합니다.' 
    });
  }

  try {
    // 외래 키 제약조건 활성화
    await new Promise((resolve, reject) => {
      db.run('PRAGMA foreign_keys = ON', err => {
        if (err) return reject(err);
        resolve();
      });
    });
    
    // 트랜잭션 시작
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);
        resolve();
      });
    });
    
    try {
      // 캐릭터 삭제 (관련 테이블은 CASCADE로 자동 삭제됨)
      const changes = await new Promise((resolve, reject) => {
        db.run(`DELETE FROM characters WHERE characterName = ?`, [characterName], function(err) {
          if (err) return reject(err);
          resolve(this.changes);
        });
      });
      
      // 트랜잭션 커밋
      await new Promise((resolve, reject) => {
        db.run('COMMIT', err => {
          if (err) return reject(err);
          resolve();
        });
      });
      
      if (changes > 0) {
        res.redirect('/rank?deleted=' + encodeURIComponent(characterName));
      } else {
        res.redirect('/rank?error=' + encodeURIComponent(`캐릭터 '${characterName}'을(를) 찾을 수 없습니다.`));
      }
    } catch (err) {
      // 오류 발생 시 롤백
      await new Promise(resolve => {
        db.run('ROLLBACK', () => resolve());
      });
      throw err;
    }
  } catch (error) {
    console.error('캐릭터 삭제 오류:', error);
    res.redirect('/rank?error=' + encodeURIComponent('캐릭터 삭제 중 오류가 발생했습니다.'));
  }
});

// HTML 태그를 모두 제거하는 헬퍼 함수 추가
function stripHtml(html) {
  // 문자열 타입이 아니면 빈 문자열 반환
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, '');
}

// API로 받은 raw 데이터를 가공하여 클라이언트로 전달할 형태로 변환하는 함수 추가
function transformCharacterData(raw) {
  const processed = {};
  // 프로필 정보
  processed.profile = {
    name: raw.characters.CharacterName,
    server: raw.characters.ServerName,
    class: raw.characters.CharacterClassName,
    level: raw.characters.CharacterLevel,
    itemLevel: raw.characters.ItemAvgLevel,
    image: raw.characters.CharacterImage,
    guild: raw.characters.GuildName,
    lastUpdated: raw.characters.lastUpdated
  };
  
  processed.stats = raw.characters.stats;
  processed.tendencies = raw.characters.tendencies;

  processed.elixirLevels = 0;
  processed.equipment = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['투구', '어깨', '상의', '하의', '장갑', '무기'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        const result = {
          type: item.Type, 
          name: item.Name, 
          icon: item.Icon,
          grade: item.Grade,
          reforgedLevel: 0
        };
        
        let tooltip;
        
        try {
          tooltip = item.Tooltip.replace(/<[^>]*>/g, '').trim();
          tooltip = JSON.parse(tooltip);
        } catch (e) {
          console.error('장비 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }
        // 아이템 이름
        if (tooltip.Element_000 && tooltip.Element_000.value) {
          result.name = tooltip.Element_000.value;
        }

        // 상급재련
        if (tooltip.Element_005 && tooltip.Element_005.value && typeof tooltip.Element_005.value === 'string') {
          result.reforgedLevel = tooltip.Element_005.value.match(/(\d+)\s*단계/)[1];
        }
        
        // 엘릭서
        if (tooltip.Element_009 && tooltip.Element_009.value && typeof tooltip.Element_009.value.Element_000 !== 'undefined' && typeof tooltip.Element_009.value.Element_000 !== 'string') {
          
          if(!tooltip.Element_009.value.Element_000.topStr.includes('엘릭서')) {
            result.transcendLevel = tooltip.Element_009.value.Element_000.topStr.match(/(\d+)\s*단계/)[1];
            result.transcend = tooltip.Element_009.value.Element_000.topStr.split('단계')[1];
          }
        }

        // 품질
        if (tooltip.Element_001 && tooltip.Element_001.value && tooltip.Element_001.value.qualityValue !== undefined) {
          result.quality = tooltip.Element_001.value.qualityValue;
        }
        // 엘릭서
        if(tooltip.Element_009 && tooltip.Element_009.value && tooltip.Element_009.value.Element_000 && tooltip.Element_009.value.Element_000.topStr) {
          let elixir = [];
          if (tooltip.Element_009.value.Element_000.topStr.includes('엘릭서')) {
            if (tooltip.Element_009.value.Element_000.contentStr.Element_000) {
              elixir.push(parseElixir(tooltip.Element_009.value.Element_000.contentStr.Element_000.contentStr));
              processed.elixirLevels += parseInt(tooltip.Element_009.value.Element_000.contentStr.Element_000.contentStr.split('Lv.')[1]) || 0;
            }
            if (tooltip.Element_009.value.Element_000.contentStr.Element_001) {
              elixir.push(parseElixir(tooltip.Element_009.value.Element_000.contentStr.Element_001.contentStr));
              processed.elixirLevels += parseInt(tooltip.Element_009.value.Element_000.contentStr.Element_001.contentStr.split('Lv.')[1]) || 0;
            }
            result.elixir = elixir;
          }
        }
        if(tooltip.Element_010 && tooltip.Element_010.value && tooltip.Element_010.value.Element_000 && tooltip.Element_010.value.Element_000.contentStr && tooltip.Element_010.value.Element_000.contentStr.Element_000) {
          let elixir = [];
          if (tooltip.Element_010.value.Element_000.topStr.includes('엘릭서')) {
            if (tooltip.Element_010.value.Element_000.contentStr.Element_000 && tooltip.Element_010.value.Element_000.contentStr.Element_000.contentStr) {
              elixir.push(parseElixir(tooltip.Element_010.value.Element_000.contentStr.Element_000.contentStr));
              processed.elixirLevels += parseInt(tooltip.Element_010.value.Element_000.contentStr.Element_000.contentStr.split('Lv.')[1]) || 0;
            }
            if (tooltip.Element_010.value.Element_000.contentStr.Element_001 && tooltip.Element_010.value.Element_000.contentStr.Element_001.contentStr) {
              elixir.push(parseElixir(tooltip.Element_010.value.Element_000.contentStr.Element_001.contentStr));
              processed.elixirLevels += parseInt(tooltip.Element_010.value.Element_000.contentStr.Element_001.contentStr.split('Lv.')[1]) || 0;
            }
            result.elixir = elixir;
          }
        }
        return result;
      })
      // 장비 순서 정렬: 투구, 견갑, 상의, 하의, 장갑, 무기
      .sort((a, b) => {
        const order = {
          '투구': 1,
          '어깨': 2,
          '상의': 3,
          '하의': 4,
          '장갑': 5,
          '무기': 6
        };
        
        const typeA = Object.keys(order).find(key => a.type && a.type.includes(key)) || '';
        const typeB = Object.keys(order).find(key => b.type && b.type.includes(key)) || '';
        
        return order[typeA] - order[typeB];
      })
    : [];
  processed.accessories = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['목걸이','귀걸이','반지'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        const result = {
          type: item.Type, 
          name: item.Name, 
          icon: item.Icon,
          grade: item.Grade
        };
        
        let tooltip;
        
        try {
          tooltip = item.Tooltip.replace(/<[^>]*>/g, '').trim();
          tooltip = JSON.parse(tooltip);
        } catch (e) {
          console.error('악세사리 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }

        // 품질
        if (tooltip.Element_001 && tooltip.Element_001.value && tooltip.Element_001.value.qualityValue) {
          result.quality = tooltip.Element_001.value.qualityValue;
        }

        // 연마 효과
        if (tooltip.Element_005 && tooltip.Element_005.value) {
          result.accessoryEffects = parseAccessoryEffect(tooltip.Element_005.value.Element_001);
        }
        return result;
      })
    : [];

    processed.bracelet = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['팔찌'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        const result = {
          type: item.Type,
          name: item.Name,
          icon: item.Icon,
          grade: item.Grade
        };
        let tooltip;
        try {
          tooltip = JSON.parse(item.Tooltip);
        } catch (e) {
          console.error('팔찌 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }
        
        // 팔찌 효과
        if (tooltip.Element_004 && tooltip.Element_004.value) {
          // 팔찌 효과 분석 및 등급 판별          
          const blocks = tooltip.Element_004.value.Element_001.split(/(?=<img[^>]*>)/g)
          .filter(Boolean);
          const blockEffects = {
            'defaultEffects': [],
            'lockedEffects': []
          };
          blocks.forEach(block => {
              blockEffects.defaultEffects.push(block.replace(/<[^>]*>/g, '').trim());
          });
          result.braceletEffects = blockEffects;
        }

        return result;
      })
    : [];
    
    processed.abilityStone = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['어빌리티 스톤'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        const result = {
          type: item.Type,
          name: item.Name,
          icon: item.Icon,
          grade: item.Grade
        };
        let tooltip;
        try {
          tooltip = item.Tooltip.replace(/<[^>]*>/g, '').trim();
          tooltip = JSON.parse(tooltip);
        } catch (e) {
          console.error('어빌리티 스톤 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }
        if(tooltip.Element_006 && tooltip.Element_006.value) {
          let abilityStoneEffects = [];
          abilityStoneEffects.push(tooltip.Element_006.value.Element_000.contentStr.Element_000.contentStr);
          abilityStoneEffects.push(tooltip.Element_006.value.Element_000.contentStr.Element_001.contentStr);
          abilityStoneEffects.push(tooltip.Element_006.value.Element_000.contentStr.Element_002.contentStr);
          if(tooltip.Element_006.value.Element_000.contentStr.Element_003) {
            abilityStoneEffects.push(tooltip.Element_006.value.Element_000.contentStr.Element_003.contentStr);
          }
          result.abilityStoneEffects = abilityStoneEffects;
        }else if (tooltip.Element_005 && tooltip.Element_005.value) {
          let abilityStoneEffects = [];
          abilityStoneEffects.push(tooltip.Element_005.value.Element_000.contentStr.Element_000.contentStr);
          abilityStoneEffects.push(tooltip.Element_005.value.Element_000.contentStr.Element_001.contentStr);
          abilityStoneEffects.push(tooltip.Element_005.value.Element_000.contentStr.Element_002.contentStr);
          if(tooltip.Element_005.value.Element_000.contentStr.Element_003) {
            abilityStoneEffects.push(tooltip.Element_005.value.Element_000.contentStr.Element_003.contentStr);
          }
          result.abilityStoneEffects = abilityStoneEffects;
        }

        return result;
      })
    : [];

    processed.etc = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['나침반', '부적', '문장'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        return {
          type: item.Type,
          name: item.Name,
          icon: item.Icon,
          grade: item.Grade
        }
      })
    : [];

  // 보석
  processed.gems = Array.isArray(raw.gems?.Gems)
    ? raw.gems.Gems.map(gem => {
        const nameRaw = stripHtml(gem.Name || '');
        const lvl = nameRaw.match(/(\d+)레벨/);
        const level = lvl ? parseInt(lvl[1], 10) : null;
        const name = nameRaw.replace(/\d+레벨\s?/, '').trim();
        
        let tip = {};
        try { 
          tip = typeof gem.Tooltip === 'string' ? JSON.parse(gem.Tooltip) : gem.Tooltip || {}; 
        } catch (e) {}
        
        const eh = tip.Element_006?.value?.Element_001 || '';
        const cm = eh.match(/<FONT COLOR='#[A-F0-9]+'>([^<]+)<\/FONT>/);
        const skillName = cm ? cm[1] : stripHtml(eh);
        // 1. 겁화와 멸화는 같은 종류, 작열과 홍염은 같은 종류로 분류
        const type = /겁화|멸화/.test(name) ? 'cooldown' : 'damage';
        
        return { 
          icon: gem.Icon, 
          skillIcon: gem.SkillIcon, 
          grade: gem.Grade,
          name, 
          level, 
          type, 
          skillName 
        };
      })
    : [];

  // 수집형 포인트
  processed.collectibles = Array.isArray(raw.collectibles) 
    ? raw.collectibles.map(collectible => {
      const result = {
        type: collectible.Type,
        icon: collectible.Type === '모코코 씨앗' ? '/icon_02_new.png' : 
              collectible.Type === '섬의 마음' ? '/icon_01_new.png' : 
              collectible.Type === '위대한 미술품' ? '/icon_03_new.png' : 
              collectible.Type === '거인의 심장' ? '/icon_00_new.png' : 
              collectible.Type === '이그네아의 징표' ? '/icon_06_new.png' : 
              collectible.Type === '항해 모험물' ? '/icon_04_new.png' : 
              collectible.Type === '오르페우스의 별' ? '/icon_07_new.png' : 
              collectible.Type === '기억의 오르골' ? '/icon_08_new.png' : 
              collectible.Type === '크림스네일의 해도' ? '/icon_09_new.png' : 
              collectible.Type === '세계수의 잎' ? '/icon_05_new.png' : 
              collectible.Icon,
        name: collectible.Name,
        points: collectible.Point,
        maxPoints: collectible.MaxPoint,
        percentage: collectible.MaxPoint ? Math.floor(collectible.Point / collectible.MaxPoint * 100) : 0,
        CollectiblePoints: collectible.CollectiblePoints
      };
      return result;
    })
    : [];

  // PVP 정보
  processed.colosseums = raw.colosseums || {};

  // 스킬
  processed.skills = Array.isArray(raw.combatSkills)
    ? raw.combatSkills.filter(s => s.Level > 1).map(s => ({
        name: s.SkillName || s.Name,
        level: s.Level,
        tripods: Array.isArray(s.Tripod) ? s.Tripod.filter(t => t.IsSelected) : []
      }))
    : [];

  // 각인 (ArkPassiveEffects)
  if (raw.engravings && raw.engravings.ArkPassiveEffects) {
    processed.engravings = Array.isArray(raw.engravings.ArkPassiveEffects)
      ? raw.engravings.ArkPassiveEffects.map(e => ({
          abilityStoneLevel: e.AbilityStoneLevel ? e.AbilityStoneLevel : 0,
          name: stripHtml(e.Name || ''),
          level: e.Level ? e.Level : 0,
          icon: `/${e.Name}.webp`,
          description: e.Description,
          grade: e.Grade
        }))
      : [];
  }

  // 카드
  processed.cards = Array.isArray(raw.cards.Cards) ? raw.cards.Cards : [];

  if (raw.arkpassive && raw.arkpassive.IsArkPassive) {
    const arkpassives = {
      evolution: {
        points: {},
        effects: []
      },
      awakening: {
        points: {},
        effects: []
      },
      leap: {
        points: {},
        effects: []
      }
    };
    if(raw.arkpassive.Points) {
      raw.arkpassive.Points.forEach(point => {
        point.Name === '진화' ? arkpassives.evolution.points = point : 
        point.Name === '깨달음' ? arkpassives.awakening.points = point : 
        arkpassives.leap.points = point;
      });
    }

    if(raw.arkpassive.Effects) {
      raw.arkpassive.Effects.forEach(effect => {
        effect.Name === '진화' ? arkpassives.evolution.effects.push(effect) : 
        effect.Name === '깨달음' ? arkpassives.awakening.effects.push(effect) : 
        arkpassives.leap.effects.push(effect);
      });
    }

    processed.arkpassive = arkpassives;
  }
  return processed;
}

// 캐릭터 상세 정보 페이지
router.get('/character/:name', async (req, res) => {
  const characterName = req.params.name;
  
  try {
    // 테이블 구조 확인 - updatedAt 또는 lastUpdated 컬럼 확인
    const timeColumn = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(characters)`, [], (err, columns) => {
        if (err) {
          console.error('테이블 정보 조회 오류:', err);
          return resolve('lastUpdated'); // 기본값을 lastUpdated로 변경
        }
        
        // 컬럼 목록에서 lastUpdated 또는 updatedAt 찾기
        let columnNames = [];
        if (Array.isArray(columns)) {
          columnNames = columns.map(col => col.name || '');
        } else {
          for (let key in columns) {
            if (columns[key] && columns[key].name) {
              columnNames.push(columns[key].name);
            }
          }
        }
        
        let result = 'lastUpdated'; // 기본값
        
        if (columnNames.includes('lastUpdated')) {
          result = 'lastUpdated';
        } else if (columnNames.includes('updatedAt')) {
          result = 'updatedAt';
        }
        
        resolve(result);
      });
    });
    
    // 데이터베이스에서 캐릭터 기본 정보 조회
    db.get(`SELECT * FROM characters WHERE characterName = ?`, [characterName], (err, character) => {
      if (err || !character) {
        return res.status(404).render('characterDetail', { 
          character: null, 
          error: '캐릭터 정보를 찾을 수 없습니다.' 
        });
      }
      
      // 캐릭터가 길드원인지 확인
      if (!character.isGuildMember) {
        // 길드원이 아닐 경우 순위표 페이지로 리다이렉트
        db.all(`SELECT * FROM characters 
                WHERE isGuildMember = 1 
                ORDER BY itemLevel DESC`, [], (err, characters) => {
          return res.status(403).render('rank', {
            characters: characters || [],
            error: `'${characterName}'님은 별단 길드원이 아닙니다. 별단 길드원만 조회할 수 있습니다.`
          });
        });
        return;
      }
      
      // 모든 세부 정보 테이블에서 데이터를 조회
      const tableNames = ['equipment', 'avatars', 'combatSkills', 'engravings', 'cards', 'gems', 'colosseums', 'collectibles', 'arkpassive'];
      const queries = tableNames.map(tableName => {
        return new Promise((resolve, reject) => {
          // 테이블이 존재하는지 먼저 확인
          db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName], (err, tableExists) => {
            if (err) return reject(err);
            
            if (!tableExists) {
              // 테이블이 없으면 빈 데이터 반환
              console.log(`테이블 ${tableName}이 존재하지 않습니다.`);
              return resolve({ [tableName]: null });
            }
            
            // 테이블이 있으면 데이터 조회
            db.get(`SELECT data FROM ${tableName} WHERE characterName = ?`, [characterName], (err, result) => {
              if (err) {
                console.error(`${tableName} 데이터 조회 오류:`, err);
                return resolve({ [tableName]: null });
              }
              
              if (result && result.data) {
                try {
                  // 데이터가 유효한 JSON인지 확인
                  if (typeof result.data !== 'string' || result.data.trim() === '') {
                    console.error(`${tableName} 데이터가 유효한 문자열이 아닙니다.`);
                    return resolve({ [tableName]: null });
                  }
                  
                  const parsedData = JSON.parse(result.data);
                  //console.log(`${tableName} 데이터 파싱 성공:`, 
                  //  tableName === 'engravings' || tableName === 'arkpassive' ? 
                  //  JSON.stringify(parsedData, null, 2) : '데이터 존재함');
                  
                  resolve({ [tableName]: parsedData });
                } catch (e) {
                  console.error(`${tableName} 데이터 파싱 오류:`, e);
                  console.error(`원본 데이터:`, result.data?.substring(0, 200) + '...');
                  resolve({ [tableName]: null });
                }
              } else {
                console.log(`${tableName} 데이터가 없습니다.`);
                resolve({ [tableName]: null });
              }
            });
          });
        });
      });
      
      // 모든 쿼리가 완료되면 결과를 합쳐서 응답
      Promise.all(queries)
        .then(results => {
          // rawMap에 모든 테이블 결과 결합
          const rawMap = {};
          results.forEach(r => Object.assign(rawMap, r));
          // DB에서 조회한 기본 캐릭터 정보도 추가
          const data = JSON.parse(character.data);
          rawMap.characters = {
            CharacterName: character.characterName,
            ServerName: character.serverName,
            CharacterLevel: character.characterLevel,
            CharacterClassName: character.className,
            ItemAvgLevel: character.itemLevel.toString(),
            CharacterImage: character.data ? JSON.parse(character.data)?.CharacterImage || '' : '',
            GuildName: character.guildName,
            lastUpdated: character[timeColumn] || '정보 없음',
            stats: data.Stats,
            tendencies: data.Tendencies
          };
          // 가공 함수 호출
          const processed = transformCharacterData(rawMap);
          res.render('characterDetail', {
            character: processed,
            error: null
          });
        })
        .catch(error => {
          console.error('캐릭터 상세 정보 조회 오류:', error);
          res.status(500).render('characterDetail', { 
            character: null, 
            error: '캐릭터 정보를 불러오는데 실패했습니다.' 
          });
        });
    });
  } catch (error) {
    console.error('캐릭터 상세 정보 조회 오류:', error);
    res.status(500).render('characterDetail', { 
      character: null, 
      error: '캐릭터 정보를 불러오는데 실패했습니다.' 
    });
  }
});

// API 라우트 - 모든 캐릭터 정보 가져오기
router.get('/api/characters', async (req, res) => {
  try {
    db.all(`SELECT * FROM characters WHERE isGuildMember = 1 ORDER BY itemLevel DESC`, [], (err, characters) => {
      if (err) {
        return res.status(500).json({ 
          success: false, 
          message: '데이터를 불러오는데 실패했습니다.' 
        });
      }
      
      res.json({ success: true, characters });
    });
  } catch (error) {
    console.error('API 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

function parseElixir(elixir) {
  const elixirOptions = ['회심', '달인', '행운', '칼날 방패', '진군', '신념', '선봉대', '선각자', , '강맹', '무기 공격력', '공격력', '힘', '민첩', '지능', '무력화', '마나', '물약 중독', '방랑자', '생명의 축복', '자원의 축복', '탈출의 달인', '폭발물 달인', '회피의 달인', '마법 방어력', '물리 방어력', '받는 피해 감소', '최대 생명력', '아군 강화', '아이덴티티 획득', '추가 피해', '치명타 피해', '각성기 피해', '보스 피해', '보호막 강화', '회복 강화'];
  
  const level = (elixir.match(/Lv\.\d+/) || [''])[0];
  const name = elixirOptions.find(opt => opt && elixir.includes(opt)) || 'UNKNOWN';
  return `${name} ${level}`.trim();
}

// 매일 오전 2시에 실행되는 데이터 갱신 스케줄러
cron.schedule('0 2 * * *', async () => {
  console.log('자동 데이터 갱신 스케줄러 실행 - 오전 2시');
  await refreshAllCharactersData();
});

// 모든 캐릭터 데이터 갱신 함수
async function refreshAllCharactersData() {
  try {
    console.log('모든 캐릭터 데이터 갱신 시작');
    
    // API 키 가져오기
    const apiKey = process.env.LOSTARK_API_KEY || 'YOUR_API_KEY';
    
    // 최근 1시간 내에 업데이트되지 않은 캐릭터만 조회
    const characters = await new Promise((resolve, reject) => {
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);
      
      // SQLite에서 날짜 비교를 위한 포맷 (ISO 문자열)
      const timeThreshold = oneHourAgo.toISOString();
      
      db.all(
        `SELECT characterName, lastUpdated FROM characters 
         WHERE lastUpdated IS NULL OR lastUpdated < ?`, 
        [timeThreshold], 
        (err, rows) => {
          if (err) {
            console.error('캐릭터 목록 조회 오류:', err);
            return reject(err);
          }
          resolve(rows);
        }
      );
    });
    
    console.log(`최근 1시간 내 업데이트되지 않은 캐릭터 수: ${characters.length}개`);
    
    // 각 캐릭터별로 API 요청 (비동기 처리)
    const results = [];
    
    // API 요청 병목 현상 방지를 위해 순차 처리
    for (const character of characters) {
      const characterName = character.characterName;
      console.log(`${characterName} 데이터 갱신 시작 (마지막 업데이트: ${character.lastUpdated || '없음'})`);
      
      try {
        // API 요청 및 데이터 저장
        const result = await fetchAndSaveCharacterData(characterName, apiKey);
        results.push({ characterName, success: result.success, isGuildMember: result.isGuildMember });
        
        // 길드원이 아닌 캐릭터는 삭제
        if (result.success && !result.isGuildMember) {
          console.log(`${characterName}은(는) 더 이상 길드원이 아니므로 데이터 삭제`);
          
          // 외래 키 제약조건 활성화
          await new Promise((resolve, reject) => {
            db.run('PRAGMA foreign_keys = ON', err => {
              if (err) return reject(err);
              resolve();
            });
          });
          
          // 캐릭터 삭제 (CASCADE로 관련 데이터도 자동 삭제)
          await new Promise((resolve, reject) => {
            db.run(`DELETE FROM characters WHERE characterName = ?`, [characterName], function(err) {
              if (err) return reject(err);
              console.log(`${characterName} 삭제 완료 (길드원 아님)`);
              resolve();
            });
          });
        }
        
        // API 요청 사이 간격 (1초)
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`${characterName} 데이터 갱신 중 오류:`, error);
        results.push({ characterName, success: false, error: error.message });
      }
    }
    
    return results;
  } catch (error) {
    console.error('캐릭터 데이터 갱신 오류:', error);
    throw error;
  }
}

// 수동으로 모든 캐릭터 데이터 갱신하는 API
router.get('/api/refresh-all', async (req, res) => {
  try {
    const results = await refreshAllCharactersData();
    res.json({ 
      success: true,
      message: '모든 캐릭터 데이터 갱신 완료',
      results
    });
  } catch (error) {
    console.error('데이터 갱신 API 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '데이터 갱신 중 오류가 발생했습니다.',
      error: error.message 
    });
  }
});

// 단일 캐릭터 정보를 갱신하는 API
router.get('/api/refresh-character/:name', async (req, res) => {
  try {
    const characterName = req.params.name;
    
    if (!characterName) {
      return res.status(400).json({ 
        success: false, 
        message: '캐릭터 이름이 필요합니다.' 
      });
    }
    
    console.log(`단일 캐릭터 정보 갱신 요청: ${characterName}`);
    
    // API 키 가져오기
    const apiKey = process.env.LOSTARK_API_KEY || 'YOUR_API_KEY';
    
    // 마지막 업데이트 시간 확인
    const updateCheck = await shouldUpdateCharacter(characterName);
    const needsUpdate = updateCheck.needsUpdate;
    const timeColumn = updateCheck.timeColumn;
    
    // 이미 최근에 업데이트되었는지 확인 (1분 이내)
    if (!needsUpdate) {
      const character = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM characters WHERE characterName = ?`, [characterName], (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
      
      if (!character) {
        return res.status(404).json({ 
          success: false, 
          message: '캐릭터 정보를 찾을 수 없습니다.' 
        });
      }
      
      const lastUpdated = new Date(character[timeColumn]);
      const now = new Date();
      const diffSeconds = Math.floor((now - lastUpdated) / 1000);
      
      if (diffSeconds < 60) {
        return res.status(429).json({ 
          success: false, 
          message: `최근에 이미 갱신되었습니다. ${60 - diffSeconds}초 후에 다시 시도해주세요.` 
        });
      }
    }
    
    // API 호출 및 데이터 저장
    const result = await fetchAndSaveCharacterData(characterName, apiKey);
    
    if (!result.success) {
      return res.status(500).json({ 
        success: false, 
        message: '캐릭터 정보를 가져오는데 실패했습니다.' 
      });
    }
    
    if (!result.isGuildMember) {
      return res.status(403).json({ 
        success: false, 
        message: `'${characterName}'님은 별단 길드원이 아닙니다.` 
      });
    }
    
    // 성공 응답
    res.json({ 
      success: true, 
      message: '캐릭터 정보가 성공적으로 갱신되었습니다.',
      characterName
    });
    
  } catch (error) {
    console.error('캐릭터 갱신 API 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

  function parseAccessoryEffect(effectStr) {
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = Object.keys(accessoryEffectGrades)
    .sort((a, b) => b.length - a.length)      // 긴 이름 우선
    .map(escape)
    .join('|');
    const regex = new RegExp(`(${namePattern})\\s*\\+\\s*([0-9.]+%?)`, 'g');
    // 2) 매칭 반복
    const result = [];
    let m;
    while ((m = regex.exec(effectStr)) !== null) {
      const rawName = m[1];            // ex) "공격력", "무기 공격력%"
      const value   = m[2];            // ex) "0.95%", "195"

      // 2-1) 이름 표시용('%' 제외)
      const name = rawName.replace('%', '');

      // 2-2) 등급(상·중·하) 판정
      let grade = 'Unknown';
      const candidates = [
        rawName,
        rawName.endsWith('%') ? rawName.slice(0, -1) : rawName + '%',
        name,
        name + '%'
      ];
      outer: for (const key of candidates) {
        const tiers = accessoryEffectGrades[key];
        if (!tiers) continue;
        for (const tier of Object.values(tiers)) {
          for (const [g, v] of Object.entries(tier)) {
            if (v === value) { grade = g; break outer; }
          }
        }
      }

      result.push({ name, grade, value });
    }
    return result;
  }

  const accessoryEffectGrades = {
    '아군 피해량 강화 효과' : {
      'T4' : {
        '상' : '7.50%',
        '중' : '4.50%',
        '하' : '2.00%'
      },
      'T3' : {
        '상' : '4.32%',
        '중' : '2.58%',
        '하' : '1.14%'
      }
    },
    '아군 공격력 강화 효과' : {
      'T4' : {
        '상' : '5.00%',
        '중' : '3.00%',
        '하' : '1.35%'
      },
      'T3' : {
        '상' : '2.88%',
        '중' : '1.72%',
        '하' : '0.76%'
      }
    },
    '적에게 주는 피해' : {
      'T4' : {
        '상' : '2.00%',
        '중' : '1.20%',
        '하' : '0.55%'
      },
      'T3' : {
        '상' : '1.15%',
        '중' : '0.69%',
        '하' : '0.30%'
      }
    },
    '추가 피해' : {
      'T4' : {
        '상' : '2.60%',
        '중' : '1.60%',
        '하' : '0.70%'
      },
      'T3' : {
        '상' : '1.50%',
        '중' : '0.90%',
        '하' : '0.39%'
      }
    },
    '공격력%' : {
      'T4' : {
        '상' : '1.55%',
        '중' : '0.95%',
        '하' : '0.40%'
      },
      'T3' : {
        '상' : '0.89%',
        '중' : '0.54%',
        '하' : '0.24%'
      }
    },
    '무기 공격력%' : {
      'T4' : {
        '상' : '3.00%',
        '중' : '1.80%',
        '하' : '0.80%'
      },
      'T3' : {
        '상' : '1.72%',
        '중' : '1.04%',
        '하' : '0.46%'
      }
    },
    '파티원 회복 효과' : {
      'T4' : {
        '상' : '3.50%',
        '중' : '2.10%',
        '하' : '0.95%'
      },
      'T3' : {
        '상' : '2.01%',
        '중' : '1.21%',
        '하' : '0.54%'
      }
    },
    '파티원 보호막 효과' : {
      'T4' : {
        '상' : '3.50%',
        '중' : '2.10%',
        '하' : '0.95%'
      },
      'T3' : {
        '상' : '2.01%',
        '중' : '1.21%',
        '하' : '0.54%'
      }
    },
    '세레나데, 신앙, 조화 게이지 획득량' : {
      'T4' : {
        '상' : '6.00%',
        '중' : '3.60%',
        '하' : '1.60%'
      },
      'T3' : {
        '상' : '3.45%',
        '중' : '2.07%',
        '하' : '0.90%'
      }
    },
    '낙인력' : {
      'T4' : {
        '상' : '8.00%',
        '중' : '4.80%',
        '하' : '2.15%'
      },
      'T3' : {
        '상' : '4.60%',
        '중' : '2.76%',
        '하' : '1.20%'
      }
    },
    '치명타 적중률' : {
      'T4' : {
        '상' : '1.55%',
        '중' : '0.95%',
        '하' : '0.40%'
      },
      'T3' : {
        '상' : '0.89%',
        '중' : '0.54%',
        '하' : '0.24%'
      }
    },
    '치명타 피해' : {
      'T4' : {
        '상' : '4.00%',
        '중' : '2.40%',
        '하' : '1.10%'
      },
      'T3' : {
        '상' : '2.30%',
        '중' : '1.38%',
        '하' : '0.61%'
      }
    },
    '최대 생명력' : {
      'T4' : {
        '상' : '6500',
        '중' : '3250',
        '하' : '1300'
      },
      'T3' : {
        '상' : '2756',
        '중' : '1654',
        '하' : '719'
      }
    },
    '공격력' : {
      'T4' : {
        '상' : '390',
        '중' : '195',
        '하' : '80'
      },  
      'T3' : {
        '상' : '68',
        '중' : '33',
        '하' : '14'
      }
    },
    '무기 공격력' : {
      'T4' : {
        '상' : '960',
        '중' : '480',
        '하' : '195'
      },  
      'T3' : {
        '상' : '155',
        '중' : '75',
        '하' : '32'
      }
    },
    '최대 마나' : {
      'T4' : {
        '상' : '30',
        '중' : '15',
        '하' : '6'
      },  
      'T3' : {
        '상' : '17',
        '중' : '10',
        '하' : '5'
      }
    },
    '상태이상 공격 지속시간' : {
      'T4' : {
        '상' : '1.00%',
        '중' : '0.50%',
        '하' : '0.20%'
      },  
      'T3' : {
        '상' : '0.58%',
        '중' : '0.35%',
        '하' : '0.15%'
      }
    },
    '최대 마나' : {
      'T4' : {
        '상' : '30',
        '중' : '15',
        '하' : '6'
      },  
      'T3' : {
        '상' : '21',
        '중' : '13',
        '하' : '5'
      }
    },
    '전투 중 생명력 회복량' : {
      'T4' : {
        '상' : '50',
        '중' : '25',
        '하' : '10'
      },
      'T3' : {
        '상' : '21',
        '중' : '13',
        '하' : '5'
      }
    }
  };
  function toNumber(str, { group = ',', decimal = '.' } = {}) {
    if (typeof str !== 'string') return NaN;
  
    // 1) 부호·공백 정리
    let s = str.trim().replace(/\u00A0/g, '');    // \u00A0 = NBSP
    const sign = s.startsWith('(') && s.endsWith(')') ? -1 : 1;
    s = s.replace(/[()]/g, '');
  
    // 2) 구분자 제거 후 표준 “.” 소수점으로 맞추기
    const reGroup = new RegExp('\\' + group, 'g');   // ex) /,/g
    s = s.replace(reGroup, '').replace(decimal, '.');
  
    // 3) 숫자 변환
    const n = parseFloat(s);
    return sign * (isFinite(n) ? n : NaN);
  }

module.exports = router;