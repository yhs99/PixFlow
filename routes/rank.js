const express = require('express');
const router = express.Router();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./gallery.db');

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
    isGuildMember BOOLEAN DEFAULT 0,
    lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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
      
      console.log(`사용할 시간 컬럼: ${timeColumn}`);
      
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
    
    // 길드원이 아닐 경우 데이터 저장하지 않음
    if (!isGuildMember) {
      console.log(`${characterName}님은 ${GUILD_NAME} 길드원이 아닙니다.`);
      return { 
        success: false, 
        isGuildMember: false, 
        characterName
      };
    }
    
    // 데이터베이스에 캐릭터 정보 저장
    await new Promise((resolve, reject) => {
      // 트랜잭션 시작
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
          console.error('트랜잭션 시작 오류:', err);
          return reject(err);
        }
        
        // 적절한 컬럼명 사용
        console.log(`characters 테이블에 데이터 삽입 시도: ${characterName}`);
        const query = `INSERT OR REPLACE INTO characters 
                      (characterName, serverName, itemLevel, className, characterLevel, guildName, data, isGuildMember, ${timeColumn}) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
        
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
          ],
          function(err) {
            if (err) {
              console.error('캐릭터 데이터 삽입 오류:', err);
              db.run('ROLLBACK', () => reject(err));
            } else {
              console.log(`캐릭터 데이터 삽입 성공: ${characterName}, rowid: ${this.lastID}`);
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  console.error('트랜잭션 커밋 오류:', commitErr);
                  db.run('ROLLBACK', () => reject(commitErr));
                } else {
                  resolve();
                }
              });
            }
          }
        );
      });
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
        const query = `INSERT OR REPLACE INTO ${table.name} 
                      (characterName, data, ${timeColumn}) 
                      VALUES (?, ?, CURRENT_TIMESTAMP)`;
        
        db.run(query,
          [
            characterName,
            JSON.stringify(table.data),
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
    
    return { success: true, isGuildMember, characterName };
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
          
          // 각 형제 캐릭터 처리 진행 상황 업데이트를 위한 래퍼 함수
          const processSiblingWithProgress = async (sibling) => {
            const siblingName = sibling.CharacterName;
            
            // 이미 DB에 존재하고 최근에 업데이트되었는지 확인
            const updateCheck = await shouldUpdateCharacter(siblingName);
            const needsUpdate = updateCheck.needsUpdate;
            
            if (!sibling.CharacterName || sibling.ServerName !== '카제로스') {
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 서버가 카제로스가 아닙니다.`, percentage);
              return null;
            }
            
            if (!needsUpdate) {
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
                return siblingName;
              }
              
              return null;
            }
            
            try {
              // API 호출 및 데이터 저장
              const result = await fetchAndSaveCharacterData(siblingName, apiKey);
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              
              if (result.success && result.isGuildMember) {
                sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 길드원 확인됨`, percentage);
                return siblingName;
              } else {
                sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 길드원이 아님`, percentage);
                return null;
              }
            } catch (error) {
              processedCount++;
              const percentage = 70 + Math.floor((processedCount / totalSiblings) * 20);
              sendProgress('siblings_processing', `원정대 캐릭터 처리 중 (${processedCount}/${totalSiblings}): ${siblingName} - 오류 발생`, percentage);
              console.error(`형제 캐릭터 ${siblingName} 처리 중 오류 발생:`, error);
              return null;
            }
            
            // 1초 대기
            await new Promise(resolve => setTimeout(resolve, 1000));
          };
          
          // 형제 캐릭터 순차적 처리
          const siblingPromises = [];
          for (const sibling of siblings) {
            siblingPromises.push(processSiblingWithProgress(sibling));
          }
          
          const guildMemberSiblings = (await Promise.all(siblingPromises)).filter(Boolean);
          
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
      const guildMemberSiblings = await fetchSiblingCharacters(siblings, apiKey, updateCheck.timeColumn);
      
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
  
  processed.equipment2 = raw.equipment;
  // 엘릭서 정보 추출
  for(const item of raw.equipment) {
    if(item.Tooltip && item.Tooltip.includes('엘릭서')) {
      console.log(extractElixir(item));
    }
  }

  // 통계 정보 가공
  // 장비 정보 가공 
  processed.equipment = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => !['목걸이','귀걸이','반지','팔찌','어빌리티 스톤'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        // 장비 데이터 구조 검사
        if (!item.Tooltip) return { type: item.Type, name: item.Name, icon: item.Icon };
        
        let tooltip;
        try {
          tooltip = typeof item.Tooltip === 'string' ? JSON.parse(item.Tooltip) : item.Tooltip;
        } catch (e) {
          console.error('장비 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }
        
        // 기본 정보
        const result = { 
          type: item.Type, 
          name: item.Name, 
          icon: item.Icon 
        };
        
        // 품질
        if (tooltip.Element_001 && tooltip.Element_001.value && tooltip.Element_001.value.qualityValue !== undefined) {
          result.quality = tooltip.Element_001.value.qualityValue;
        }
        
        // 상급 재련 단계 추출
        if (tooltip.Element_005 && tooltip.Element_005.value) {
          const reforgedText = stripHtml(tooltip.Element_005.value);
          const reforgedMatch = reforgedText.match(/(\d+)단계/);
          if (reforgedMatch) {
            result.reforgedLevel = parseInt(reforgedMatch[1], 10);
          }
        }
        
        // 초월 단계 추출
        if (tooltip.Element_008) {
          const keys = Object.keys(tooltip.Element_008.value || {});
          if (keys.length > 0) {
            const transcendHtml = tooltip.Element_008.value[keys[0]].topStr;
            if (transcendHtml) {
              const transcendText = stripHtml(transcendHtml);
              const transcendMatch = transcendText.match(/(\d+)단계/);
              if (transcendMatch) {
                result.transcendLevel = parseInt(transcendMatch[1], 10);
              }
            }
          }
        }
        
        
        
        return result;
      })
    : [];

  // 악세사리 (목걸이, 귀걸이, 반지, 팔찌, 어빌리티 스톤)
  processed.accessories = Array.isArray(raw.equipment)
    ? raw.equipment.filter(item => ['목걸이','귀걸이','반지','팔찌','어빌리티 스톤'].some(t => item.Type && item.Type.includes(t)))
      .map(item => {
        if (!item.Tooltip) return { 
          type: item.Type, 
          name: item.Name, 
          icon: item.Icon 
        };
        
        let tooltip;
        try {
          tooltip = typeof item.Tooltip === 'string' ? JSON.parse(item.Tooltip) : item.Tooltip;
        } catch (e) {
          console.error('악세사리 툴팁 파싱 오류:', e);
          return { type: item.Type, name: item.Name, icon: item.Icon };
        }
        
        // 기본 정보
        const acc = { 
          type: item.Type, 
          name: item.Name, 
          icon: item.Icon 
        };
        
        // 품질
        if (tooltip.Element_001 && tooltip.Element_001.value && tooltip.Element_001.value.qualityValue !== undefined) {
          acc.quality = tooltip.Element_001.value.qualityValue;
        }
        
        // 기본 효과
        const effects = [];
        if (tooltip.Element_006 && tooltip.Element_006.value && tooltip.Element_006.value.Element_001) {
          const baseStr = tooltip.Element_006.value.Element_001;
          const parsedEffects = stripHtml(baseStr).split('<BR>')
            .filter(s => s && s.trim().length > 0)
            .map(s => stripHtml(s).trim());
          
          for (const effect of parsedEffects) {
            if (effect.includes(':')) {
              const [name, value] = effect.split(':').map(s => s.trim());
              effects.push({ name, value });
            } else {
              effects.push({ name: effect, value: '' });
            }
          }
        }
        
        if (effects.length > 0) {
          acc.effects = effects;
        }
        
        // 팔찌 효과
        if (item.Type && item.Type.includes('팔찌')) {
          // 3. 팔찌 옵션 데이터 보강
          const braceletEffects = [];
          
          // 기본 효과 처리
          if (effects.length > 0) {
            braceletEffects.push(...effects.map(e => ({
              type: '기본효과',
              name: e.name,
              value: e.value
            })));
          }
          
          // 추가 효과 처리 (Element_007)
          if (tooltip.Element_007 && tooltip.Element_007.value) {
            const additionalStr = typeof tooltip.Element_007.value === 'string' ? 
              tooltip.Element_007.value : 
              (tooltip.Element_007.value.Element_001 || '');
            
            const additionalEffects = stripHtml(additionalStr).split('<BR>')
              .filter(s => s && s.trim().length > 0)
              .map(s => stripHtml(s).trim());
              
            for (const effect of additionalEffects) {
              if (effect.includes(':')) {
                const [name, value] = effect.split(':').map(s => s.trim());
                braceletEffects.push({ type: '추가효과', name, value });
              } else if (effect) {
                braceletEffects.push({ type: '추가효과', name: effect, value: '' });
              }
            }
          }
          
          acc.braceletEffects = braceletEffects;
        }
        
        // 어빌리티 스톤 각인
        if (item.Type && item.Type.includes('어빌리티 스톤')) {
          // 6. 어빌리티 스톤 처리 보강
          acc.abilityStone = {
            effects: effects.map(e => ({ name: e.name, value: e.value })),
            engravings: [],
            negativeEngravings: []
          };
          
          // 각인 효과
          const engr = [];
          const negativeEngr = [];
          const txt = tooltip.Element_006?.value?.Element_001 || '';
          if (txt) {
            const pattern = /<FONT COLOR='#[A-F0-9]+'>(.+?)<\/FONT>/g;
            let m;
            while ((m = pattern.exec(txt))) {
              if (m[1] && m[1].includes('+')) {
                const parts = m[1].split('+');
                if (parts.length === 2) {
                  // 양수인 경우 일반 각인, 음수인 경우 페널티 각인
                  const level = parseInt(parts[1].trim(), 10);
                  const engraving = { 
                    name: parts[0].trim(), 
                    level: Math.abs(level),
                    description: '' // tooltip으로 표시할 설명
                  };
                  
                  if (level < 0) {
                    negativeEngr.push(engraving);
                  } else {
                    engr.push(engraving);
                  }
                }
              }
            }
          }
          
          if (engr.length > 0) {
            acc.abilityStone.engravings = engr;
          }
          
          if (negativeEngr.length > 0) {
            acc.abilityStone.negativeEngravings = negativeEngr;
          }
        }
        
        return acc;
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
          name, 
          level, 
          type, 
          skillName 
        };
      })
    : [];

  // 수집형 포인트
  processed.collectibles = raw.collectibles
    ? {
        Points: raw.collectibles.Points,
        MaxPoint: raw.collectibles.MaxPoint,
        percentage: raw.collectibles.MaxPoint ? Math.floor(raw.collectibles.Points / raw.collectibles.MaxPoint * 100) : 0
      }
    : {};

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
  if (raw.arkpassive && raw.arkpassive.ArkPassiveEffects) {
    processed.engravings = Array.isArray(raw.arkpassive.ArkPassiveEffects)
      ? raw.arkpassive.ArkPassiveEffects.map(e => ({
          name: stripHtml(e.Name || ''),
          level: e.Level,
          icon: e.Icon || ''
        }))
      : [];
  } else if (raw.engravings && raw.engravings.Effects) {
    processed.engravings = Array.isArray(raw.engravings.Effects)
      ? raw.engravings.Effects.map(e => ({
          name: stripHtml(e.Name || ''),
          level: e.Level,
          icon: e.Icon || ''
        }))
      : [];
  } else {
    processed.engravings = [];
  }

  // 카드
  processed.cards = Array.isArray(raw.cards) ? raw.cards : [];

  // 아크패시브
  processed.arkpassive = {};
  
  if (raw.arkpassive) {
    processed.arkpassive = {
      // Points 배열 처리
      Points: raw.arkpassive.Points || [],
      // 전체 효과 처리
      Effects: raw.arkpassive.Effects || []
    };
    
    // 5. 아크패시브 분류 (진화, 깨달음, 도약)
    const arkPassiveCategories = {
      evolution: [], // 진화
      awakening: [], // 깨달음
      leap: []       // 도약
    };
    
    if (Array.isArray(raw.arkpassive.ArkPassiveEffects)) {
      raw.arkpassive.ArkPassiveEffects.forEach(effect => {
        const name = stripHtml(effect.Name || '');
        const category = name.includes('진화') ? 'evolution' :
                         name.includes('깨달음') ? 'awakening' :
                         name.includes('도약') ? 'leap' : 'other';
        
        if (category !== 'other') {
          arkPassiveCategories[category].push({
            name,
            level: effect.Level || effect.Tier || 1,
            icon: effect.Icon || '',
            description: stripHtml(effect.Description || '')
          });
        }
      });
    }
    
    processed.arkpassive.categories = arkPassiveCategories;
    
    // ActiveAwakeningEngraving이 있으면 메인 정보로 활용
    if (raw.arkpassive.ActiveAwakeningEngraving) {
      const act = raw.arkpassive.ActiveAwakeningEngraving;
      const tier = raw.arkpassive.AwakeningTier || act.Tier || 1;
      const desc = act.Description ? stripHtml(act.Description) : '';
      
      let tierEff = '';
      if (Array.isArray(act.AwakeningEffects) && act.AwakeningEffects[tier - 1]) {
        tierEff = stripHtml(act.AwakeningEffects[tier - 1].Description || '');
      }
      
      processed.arkpassive.name = stripHtml(act.Name || '');
      processed.arkpassive.icon = act.Icon || '';
      processed.arkpassive.tier = tier;
      processed.arkpassive.description = desc;
      processed.arkpassive.tierEffect = tierEff;
    }
  }

  // 4. Engravings 데이터 처리 (ArkPassiveEffects)
  processed.engravingData = {};
  if (raw.engravings.ArkPassiveEffects) {
    processed.engravingData.equipped = raw.engravings.ArkPassiveEffects.map(eng => ({
      name: eng.Name,
      level: eng.Level,
      grade: eng.Grade,
      description: eng.Description,
      AbilityStoneLevel: eng.AbilityStoneLevel ? eng.AbilityStoneLevel : 0,
    }));
  }
  if (raw.arkpassive) {
    processed.arkpassive.points = raw.arkpassive.Points;
    processed.arkpassive.effects = raw.arkpassive.Effects;
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
          rawMap.characters = {
            CharacterName: character.characterName,
            ServerName: character.serverName,
            CharacterLevel: character.characterLevel,
            CharacterClassName: character.className,
            ItemAvgLevel: character.itemLevel.toString(),
            CharacterImage: character.data ? JSON.parse(character.data)?.CharacterImage || '' : '',
            GuildName: character.guildName,
            lastUpdated: character[timeColumn] || '정보 없음'
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
module.exports = router;