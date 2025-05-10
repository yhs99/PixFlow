const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { logRequest, logImageUpload, logImageDelete, logImageUpdate, logImageList } = require('./middleware/logger');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
require('dotenv').config();
const { Server } = require('socket.io');

let seats = Array(10).fill(false);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {cors: {origin: '*'}});
const port = 3000;

// 게임 상태 관리
const gameState = {
  team1: Array(5).fill(null),
  team2: Array(5).fill(null),
  waiting: Array(10).fill(null),
  players: new Map(),
  host: null,
  team1Champions: [], // 팀1의 챔피언 리스트
  team2Champions: [], // 팀2의 챔피언 리스트
  bannedChampions: [], // 밴된 챔피언 목록
  usedPlayerNumbers: new Set() // 사용된 플레이어 번호 추적
};

// 게임 모드
const GameMode = {
  NORMAL: 'normal',
  BAN: 'ban'
};

// 게임 단계
const GamePhase = {
  IDLE: 'idle',
  BAN: 'ban',
  PLAY: 'play'
};

// 방 관리
const rooms = new Map();
// 챔피언 목록
const champions = [
  'Aatrox', 'Ahri', 'Akali', 'Akshan', 'Alistar', 'Amumu', 'Anivia', 'Annie', 'Aphelios', 'Ashe',
  'AurelionSol', 'Azir', 'Bard', 'Belveth', 'Blitzcrank', 'Brand', 'Braum', 'Briar', 'Caitlyn',
  'Camille', 'Cassiopeia', 'Chogath', 'Corki', 'Darius', 'Diana', 'Draven', 'DrMundo', 'Ekko',
  'Elise', 'Evelynn', 'Ezreal', 'Fiddlesticks', 'Fiora', 'Fizz', 'Galio', 'Gangplank', 'Garen',
  'Gnar', 'Gragas', 'Graves', 'Gwen', 'Hecarim', 'Heimerdinger', 'Illaoi', 'Irelia', 'Ivern',
  'Janna', 'JarvanIV', 'Jax', 'Jayce', 'Jhin', 'Jinx', 'Kaisa', 'Kalista', 'Karma', 'Karthus',
  'Kassadin', 'Katarina', 'Kayle', 'Kayn', 'Kennen', 'Khazix', 'Kindred', 'Kled', 'KogMaw',
  'KSante', 'Leblanc', 'LeeSin', 'Leona', 'Lillia', 'Lissandra', 'Lucian', 'Lulu', 'Lux',
  'Malphite', 'Malzahar', 'Maokai', 'MasterYi', 'Milio', 'MissFortune', 'Mordekaiser', 'Morgana',
  'Naafiri', 'Nami', 'Nasus', 'Nautilus', 'Neeko', 'Nidalee', 'Nilah', 'Nocturne', 'Nunu',
  'Olaf', 'Orianna', 'Ornn', 'Pantheon', 'Poppy', 'Pyke', 'Qiyana', 'Quinn', 'Rakan', 'Rammus',
  'RekSai', 'Rell', 'RenataGlasc', 'Renekton', 'Rengar', 'Riven', 'Rumble', 'Ryze', 'Samira',
  'Sejuani', 'Senna', 'Seraphine', 'Sett', 'Shaco', 'Shen', 'Shyvana', 'Singed', 'Sion', 'Sivir',
  'Skarner', 'Sona', 'Soraka', 'Swain', 'Sylas', 'Syndra', 'TahmKench', 'Taliyah', 'Talon',
  'Taric', 'Teemo', 'Thresh', 'Tristana', 'Trundle', 'Tryndamere', 'TwistedFate', 'Twitch',
  'Udyr', 'Urgot', 'Varus', 'Vayne', 'Veigar', 'Velkoz', 'Vex', 'Vi', 'Viego', 'Viktor', 'Vladimir',
  'Volibear', 'Warwick', 'Wukong', 'Xayah', 'Xerath', 'XinZhao', 'Yasuo', 'Yone', 'Yorick',
  'Yuumi', 'Zac', 'Zed', 'Zeri', 'Ziggs', 'Zilean', 'Zoe', 'Zyra'
];

// 랜덤 챔피언 선택 함수
function getRandomChampion(teamPlayers, excludeChampions) {
  // 현재 팀에서 이미 선택된 챔피언 목록과 추가로 제외할 챔피언들
  const usedChampions = teamPlayers
    .filter(p => p && p.champion)
    .map(p => p.champion);

  // 모든 제외 챔피언들
  const allExcludedChampions = [...usedChampions, ...excludeChampions];

  // 사용 가능한 챔피언 목록 
  const availableChampions = champions.filter(c => !allExcludedChampions.includes(c));

  if (availableChampions.length === 0) {
    return null; // 사용 가능한 챔피언이 없는 경우
  }

  const randomIndex = Math.floor(Math.random() * availableChampions.length);
  return availableChampions[randomIndex];
}

// 사용되지 않은 플레이어 번호 찾기 함수
function getNextAvailablePlayerNumber(room) {
  // 1부터 50까지의 번호 중에서 사용되지 않은 가장 작은 번호 찾기
  for (let number = 1; number <= 50; number++) {
    if (!room.gameState.usedPlayerNumbers.has(number)) {
      room.gameState.usedPlayerNumbers.add(number);
      return number;
    }
  }
  
  // 모든 번호가 사용 중이면 0번 사용 (비상용)
  return 0;
}

io.on('connection', (socket) => {
  console.log('새로운 사용자가 연결되었습니다.');

  // 플레이어 재접속 처리
  socket.on('reconnect-player', (stats) => {
    console.log('플레이어 재접속 요청:', stats);
    const room = Array.from(rooms.values())[0];
    if (!room) {
      console.log('방이 존재하지 않습니다. 재접속 요청 무시');
      // 클라이언트에 방이 없음을 알림
      socket.emit('room-status', false);
      return;
    }

    // 이미 접속한 플레이어인지 확인
    const existingPlayer = room.gameState.players.get(socket.id);
    if (existingPlayer) {
      console.log('이미 접속한 플레이어입니다:', existingPlayer.nickname);
      // 기존 통계 정보 반환
      if (existingPlayer.stats) {
        socket.emit('player-stats-updated', existingPlayer.stats);
      }
      return;
    }

    // 닉네임으로 플레이어를 찾기
    let foundPlayer = null;
    let foundPlayerId = null;
    
    if (stats.nickname) {
      // 닉네임이 일치하는 플레이어 찾기
      room.gameState.players.forEach((player, playerId) => {
        if (player.nickname === stats.nickname) {
          foundPlayer = player;
          foundPlayerId = playerId;
        }
      });
    }
    
    if (foundPlayer) {
      console.log('기존 플레이어 찾음:', foundPlayer.nickname, '통계:', foundPlayer.stats);
      
      // 닉네임이 일치하는 플레이어가 이미 접속 중인 경우 처리
      if (room.players.includes(foundPlayerId)) {
        console.log('이미 접속 중인 닉네임입니다.');
        
        // 새로운 임시 닉네임 생성
        const playerNumber = getNextAvailablePlayerNumber(room);
        const tempNickname = `플레이어${playerNumber}`;
        
        // 새 플레이어 생성
        room.players.push(socket.id);
        socket.nickname = tempNickname;
        
        // 통계 정보는 복사하되 닉네임은 새로 설정
        const tempStats = foundPlayer.stats ? 
          { ...foundPlayer.stats, nickname: tempNickname } : 
          { win: 0, lose: 0, rerollCount: 2, nickname: tempNickname };
        
        room.gameState.players.set(socket.id, {
          id: socket.id,
          nickname: tempNickname,
          team: 'waiting',
          index: null,
          champion: null,
          stats: tempStats,
          isHost: false
        });
        
        // 빈 대기실 자리 찾기
        const emptySeatIndex = room.gameState.waiting.findIndex(seat => seat === null);
        if (emptySeatIndex !== -1) {
          room.gameState.waiting[emptySeatIndex] = room.gameState.players.get(socket.id);
          room.gameState.players.get(socket.id).index = emptySeatIndex;
        }
        
        // 클라이언트에 통계 정보 업데이트 전송
        socket.emit('player-stats-updated', tempStats);
        
      } else {
        // 기존에 연결이 끊어진 플레이어인 경우, 새 소켓으로 대체
        console.log('연결이 끊어진 플레이어 복원:', foundPlayer.nickname);
        
        // 플레이어 ID 업데이트
        room.gameState.players.delete(foundPlayerId);
        foundPlayer.id = socket.id;
        room.gameState.players.set(socket.id, foundPlayer);
        
        // 플레이어 리스트 업데이트
        const playerIndex = room.players.indexOf(foundPlayerId);
        if (playerIndex !== -1) {
          room.players[playerIndex] = socket.id;
        } else {
          room.players.push(socket.id);
        }
        
        socket.nickname = foundPlayer.nickname;
        
        // 저장된 좌석 정보가 있을 경우 해당 좌석으로 우선 배치 시도
        let seatAssigned = false;
        if (stats.seatInfo && stats.seatInfo.team && stats.seatInfo.index !== undefined) {
          const { team, index } = stats.seatInfo;
          
          // 유효한 팀과 인덱스인지 확인
          if ((team === 'team1' || team === 'team2' || team === 'waiting') && 
              index >= 0 && 
              index < (team === 'waiting' ? 10 : 5)) {
            
            // 이전 자리에서 플레이어 제거
            if (foundPlayer.team && foundPlayer.index !== null) {
              room.gameState[foundPlayer.team][foundPlayer.index] = null;
            }
            
            // 해당 좌석이 비어있는지 확인
            if (room.gameState[team][index] === null) {
              console.log(`저장된 좌석으로 배치: ${team} 팀의 ${index} 자리`);
              foundPlayer.team = team;
              foundPlayer.index = index;
              room.gameState[team][index] = foundPlayer;
              seatAssigned = true;
            } else {
              console.log(`요청한 좌석이 이미 차있음: ${team} 팀의 ${index} 자리`);
            }
          } else {
            console.log('유효하지 않은 좌석 정보:', stats.seatInfo);
          }
        }
        
        // 저장된 좌석으로 배치가 안 됐고, 기존 자리도 없으면 새 자리 배정
        if (!seatAssigned) {
          // 자리 업데이트
          if (foundPlayer.team && foundPlayer.index !== null) {
            if (room.gameState[foundPlayer.team][foundPlayer.index] === null) {
              // 기존 자리가 비어있으면 그 자리에 배치
              room.gameState[foundPlayer.team][foundPlayer.index] = foundPlayer;
            } else {
              // 자리가 이미 차있는 경우 대기실로 이동
              foundPlayer.team = 'waiting';
              const emptySeatIndex = room.gameState.waiting.findIndex(seat => seat === null);
              if (emptySeatIndex !== -1) {
                room.gameState.waiting[emptySeatIndex] = foundPlayer;
                foundPlayer.index = emptySeatIndex;
              }
            }
          } else {
            // 기존 자리가 없으면 대기실로 이동
            foundPlayer.team = 'waiting';
            const emptySeatIndex = room.gameState.waiting.findIndex(seat => seat === null);
            if (emptySeatIndex !== -1) {
              room.gameState.waiting[emptySeatIndex] = foundPlayer;
              foundPlayer.index = emptySeatIndex;
            }
          }
        }
        
        // 클라이언트에 통계 정보 업데이트 전송
        if (foundPlayer.stats) {
          socket.emit('player-stats-updated', foundPlayer.stats);
        }
      }
      
      // 게임 상태 업데이트
      io.to(room.id).emit('game-state', room.gameState);
      return;
    }
    
    // 기존 플레이어를 찾지 못한 경우 새 플레이어로 처리하되 기존 통계 사용
    console.log('기존 플레이어를 찾지 못함. 새 플레이어로 등록하되 통계 유지');
    const playerNumber = getNextAvailablePlayerNumber(room);
    let nickname = stats.nickname || `플레이어${playerNumber}`;
    
    // 닉네임 중복 확인
    let isDuplicate = false;
    room.gameState.players.forEach(player => {
      if (player.nickname === nickname) {
        isDuplicate = true;
      }
    });
    
    // 중복이면 임시 닉네임 생성
    if (isDuplicate) {
      nickname = `플레이어${playerNumber}`;
    }
    
    socket.join(room.id);
    room.players.push(socket.id);
    socket.nickname = nickname;
    
    // 기존 통계 사용하되 닉네임 업데이트
    const playerStats = {
      ...stats,
      nickname: nickname
    };
    
    // 새 플레이어 객체 생성
    const newPlayer = {
      id: socket.id,
      nickname: nickname,
      team: 'waiting',
      index: null,
      champion: null,
      stats: playerStats,
      isHost: socket.id === room.gameState.host
    };
    
    room.gameState.players.set(socket.id, newPlayer);
    
    // 좌석 정보가 있는 경우 해당 좌석으로 배치
    let seatAssigned = false;
    if (stats.seatInfo && stats.seatInfo.team && stats.seatInfo.index !== undefined) {
      const { team, index } = stats.seatInfo;
      
      // 유효한 팀과 인덱스인지 확인
      if ((team === 'team1' || team === 'team2' || team === 'waiting') && 
          index >= 0 && 
          index < (team === 'waiting' ? 10 : 5)) {
        
        // 해당 좌석이 비어있는지 확인
        if (room.gameState[team][index] === null) {
          console.log(`저장된 좌석으로 배치: ${team} 팀의 ${index} 자리`);
          newPlayer.team = team;
          newPlayer.index = index;
          room.gameState[team][index] = newPlayer;
          seatAssigned = true;
        } else {
          console.log(`요청한 좌석이 이미 차있음: ${team} 팀의 ${index} 자리`);
        }
      } else {
        console.log('유효하지 않은 좌석 정보:', stats.seatInfo);
      }
    }
    
    // 좌석이 할당되지 않았으면 대기실에 배치
    if (!seatAssigned) {
      console.log('빈 대기실 자리 찾기');
      const emptySeatIndex = room.gameState.waiting.findIndex(seat => seat === null);
      if (emptySeatIndex !== -1) {
        newPlayer.team = 'waiting';
        newPlayer.index = emptySeatIndex;
        room.gameState.waiting[emptySeatIndex] = newPlayer;
      }
    }
    
    // 클라이언트에 통계 정보 업데이트 전송
    socket.emit('player-stats-updated', playerStats);
    
    // 게임 상태 업데이트
    io.to(room.id).emit('game-state', room.gameState);
  });

  // 플레이어 통계 정보 업데이트
  socket.on('update-player-stats', (stats) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    const player = room.gameState.players.get(socket.id);
    if (player) {
      // 통계 정보 업데이트
      player.stats = {
        ...stats,
        nickname: player.nickname // 닉네임은 서버 측에서 관리
      };
      console.log('플레이어 통계 정보 업데이트:', player.nickname, player.stats);
      
      // 업데이트된 게임 상태 전송
      io.to(room.id).emit('game-state', room.gameState);
      
      // 클라이언트에 통계 정보 업데이트 전송
      socket.emit('player-stats-updated', player.stats);
    }
  });

  // 방 상태 확인
  socket.on('check-room', () => {
    const hasRoom = rooms.size > 0;
    console.log(`방 상태 확인 요청: ${hasRoom ? '방 있음' : '방 없음'}`);
    socket.emit('room-status', hasRoom);
  });

  // 방 생성
  socket.on('create-room', ({ name, stats }) => {
    // 방이 이미 있는 경우, 방 상태 확인 이벤트 발생
    if (rooms.size > 0) {
      console.log("방이 이미 있어 생성 요청 무시, 방 상태 응답");
      socket.emit('room-status', true);
      return;
    }

    const roomId = Date.now().toString();
    const room = {
      id: roomId,
      name,
      players: [],
      gameState: {
        team1: Array(5).fill(null),
        team2: Array(5).fill(null),
        waiting: Array(10).fill(null),
        players: new Map(),
        host: socket.id,
        team1Champions: [],
        team2Champions: [],
        bannedChampions: [], // 빈 밴 챔피언 목록 추가
        usedPlayerNumbers: new Set(),
        mode: GameMode.NORMAL, // 기본 게임 모드
        phase: GamePhase.IDLE  // 기본 게임 단계
      },
      banTimer: null // 밴 단계 타이머
    };

    // 호스트를 첫 번째 플레이어로 추가
    const playerNumber = getNextAvailablePlayerNumber(room);
    
    // 클라이언트에서 받은 통계 정보 확인
    let nickname, playerStats;
    if (stats && typeof stats === 'object') {
      // 기존 통계 정보 있으면 사용
      playerStats = {
        win: stats.win || 0,
        lose: stats.lose || 0,
        rerollCount: stats.rerollCount || 2
      };
      
      // 닉네임이 있으면 사용, 아니면 기본값 생성
      nickname = stats.nickname || `플레이어${playerNumber}`;
    } else {
      // 통계 정보가 없으면 기본값 사용
      playerStats = {
        win: 0,
        lose: 0,
        rerollCount: 2
      };
      nickname = `플레이어${playerNumber}`;
    }
    
    console.log('방 생성 시 사용할 닉네임:', nickname, '통계 정보:', playerStats);
    socket.nickname = nickname;
    room.players.push(socket.id);
    room.gameState.players.set(socket.id, {
      id: socket.id,
      nickname: nickname,
      team: 'waiting',
      index: 0,
      champion: null,
      stats: playerStats,
      isHost: true
    });

    // 호스트를 대기실에 배치
    room.gameState.waiting[0] = room.gameState.players.get(socket.id);

    rooms.set(roomId, room);
    socket.join(roomId);
    
    // 게임 상태 전송
    socket.emit('game-state', room.gameState);
    
    // 호스트에게 게임 시작 버튼 활성화
    socket.emit('host-changed', true);
    
    // 통계 정보 업데이트 전송
    socket.emit('player-stats-updated', playerStats);
    
    // 방 생성 성공 이벤트 전송
    socket.emit('room-created');
    
    console.log('방 생성 완료 및 이벤트 전송:', roomId);
  });

  // 방 입장
  socket.on('join-room', () => {
    const room = Array.from(rooms.values())[0];
    if (!room || room.players.length >= 10) return;

    // 이미 접속한 플레이어인지 확인
    const existingPlayer = room.gameState.players.get(socket.id);
    if (existingPlayer) {
      // 이미 접속한 플레이어는 자동으로 재연결
      socket.join(room.id);
      socket.emit('game-state', room.gameState);
      return;
    }

    // 새로운 플레이어에게 사용되지 않은 번호 할당
    const playerNumber = getNextAvailablePlayerNumber(room);
    const autoNickname = `플레이어${playerNumber}`;
    
    socket.join(room.id);
    room.players.push(socket.id);
    socket.nickname = autoNickname;
    
    room.gameState.players.set(socket.id, {
      id: socket.id,
      nickname: autoNickname,
      team: 'waiting',
      index: null,
      champion: null,
      stats: {
        win: 0,
        lose: 0,
        rerollCount: 2
      },
      isHost: socket.id === room.gameState.host
    });

    // 빈 대기실 자리 찾기
    const emptySeatIndex = room.gameState.waiting.findIndex(seat => seat === null);
    if (emptySeatIndex !== -1) {
      room.gameState.waiting[emptySeatIndex] = room.gameState.players.get(socket.id);
      room.gameState.players.get(socket.id).index = emptySeatIndex;
    }

    // 게임 상태 업데이트
    io.to(room.id).emit('game-state', room.gameState);
  });

  // 방 초기화
  socket.on('reset-room', (password) => {
    if (password !== 'boom') {
      socket.emit('reset-room-error', '비밀번호가 틀렸습니다.');
      return;
    }

    const room = Array.from(rooms.values())[0];
    if (!room) {
      socket.emit('reset-room-error', '방이 존재하지 않습니다.');
      return;
    }

    // 플레이어 번호 초기화
    room.gameState.usedPlayerNumbers.clear();

    // 모든 플레이어 연결 해제
    room.players.forEach(playerId => {
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.leave(room.id);
      }
    });

    // 방 삭제
    rooms.delete(room.id);

    // 모든 플레이어에게 방 초기화 알림
    io.emit('room-reset');
  });

  // 닉네임 변경
  socket.on('change-nickname', (newNickname) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    // 닉네임 길이 체크
    if (newNickname.length >= 10) {
      socket.emit('nickname-error', '닉네임은 10글자 미만이어야 합니다.');
      return;
    }

    // 닉네임 중복 확인
    const isNicknameTaken = Array.from(room.gameState.players.values())
      .some(player => player.id !== socket.id && player.nickname === newNickname);
    
    if (isNicknameTaken) {
      socket.emit('nickname-error', '이미 사용 중인 닉네임입니다.');
      return;
    }

    const player = room.gameState.players.get(socket.id);
    if (player) {
      player.nickname = newNickname;
      // 통계 정보의 닉네임도 업데이트
      if (player.stats) {
        player.stats.nickname = newNickname;
      }
      socket.nickname = newNickname;
      socket.emit('nickname-changed', newNickname);
      io.to(room.id).emit('game-state', room.gameState);
    }
  });

  // 호스트 변경 시 플레이어 정보 업데이트
  socket.on('host-changed', (isNewHost) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (room) {
      // 모든 플레이어의 호스트 상태 업데이트
      room.gameState.players.forEach(player => {
        player.isHost = player.id === room.gameState.host;
      });
      io.to(room.id).emit('game-state', room.gameState);
    }
  });

  // 자리 선택
  socket.on('select-seat', ({ team, index }) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    const player = room.gameState.players.get(socket.id);
    if (!player) return;

    // 이미 선택한 자리가 있는 경우 이전 자리 해제
    if (player.team && player.index !== null) {
      room.gameState[player.team][player.index] = null;
    }

    // 새 자리 할당
    if (room.gameState[team][index] === null) {
      room.gameState[team][index] = player;
      player.team = team;
      player.index = index;
      
      // 애니메이션을 위한 플래그 추가
      player.justMoved = true;
      
      // 다음 상태 업데이트에서 플래그를 제거하기 위해 타이머 설정
      setTimeout(() => {
        if (player && room.gameState.players.has(socket.id)) {
          player.justMoved = false;
        }
      }, 1000);
      
      // 대기실에서 제거 (팀1이나 팀2로 이동할 때만)
      if (player.team !== 'waiting' && player.team === 'waiting') {
        room.gameState.waiting[player.index] = null;
      }
      
      io.to(room.id).emit('game-state', room.gameState);
    }
  });

  // 게임 시작
  socket.on('start-game', (options = {}) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room || socket.id !== room.gameState.host) return;

    // 대기실에 사람이 있으면 시작 불가
    if (room.gameState.waiting.some(p => p)) return;

    const gameMode = options.mode || GameMode.NORMAL;
    room.gameState.mode = gameMode;
    
    if (gameMode === GameMode.BAN) {
      // 밴 모드인 경우 밴 단계 시작
      startBanPhase(room);
    } else {
      // 일반 모드인 경우 바로 게임 시작
      startGame(room);
    }
  });

  // 밴 단계 시작
  function startBanPhase(room) {
    // 게임 단계를 밴으로 변경
    room.gameState.phase = GamePhase.BAN;
    
    // 각 팀 플레이어들의 밴 상태 초기화
    room.gameState.playerBanStatus = {};
    
    // 팀별 플레이어 목록
    const team1Players = room.gameState.team1.filter(p => p !== null);
    const team2Players = room.gameState.team2.filter(p => p !== null);
    
    // 팀 플레이어들의 밴 상태 초기화
    [...team1Players, ...team2Players].forEach(player => {
      room.gameState.playerBanStatus[player.id] = {
        nickname: player.nickname,
        team: player.team,
        completed: false,
        selectingChampion: null
      };
    });
    
    // 밴 단계 시작 이벤트 전송
    io.to(room.id).emit('start-ban-phase', {
      players: room.gameState.playerBanStatus,
      state: {
        team1: room.gameState.team1,
        team2: room.gameState.team2,
        waiting: room.gameState.waiting
      }
    });
    
    // 밴 시간 제한 설정 (90초)
    room.banTimer = setTimeout(() => {
      // 시간 초과시 밴하지 않은a 플레이어들은 자동으로 랜덤 챔피언 밴
      autoCompleteBans(room);
    }, 90000);
  }

  // 자동 밴 처리 함수
  function autoCompleteBans(room) {
    // 아직 밴을 선택하지 않은 플레이어 찾기
    const pendingPlayers = Object.entries(room.gameState.playerBanStatus)
      .filter(([playerId, status]) => !status.completed)
      .map(([playerId, status]) => playerId);
    
    console.log(`밴 시간 초과: ${pendingPlayers.length}명의 플레이어가 자동 밴 처리됩니다.`);
    
    if (pendingPlayers.length === 0) {
      // 모든 플레이어가 이미 밴을 완료했다면 밴 단계 종료
      completeBanPhase(room);
      return;
    }
    
    // 각 팀별로 이미 밴된 챔피언 목록
    const team1BannedChampions = [];
    const team2BannedChampions = [];
    
    Object.values(room.gameState.playerBanStatus).forEach(status => {
      if (status.champion) {
        if (status.team === 'team1') {
          team1BannedChampions.push(status.champion);
        } else if (status.team === 'team2') {
          team2BannedChampions.push(status.champion);
        }
      }
    });
    
    // 아직 밴을 선택하지 않은 플레이어들에게 자동 밴 처리
    pendingPlayers.forEach(playerId => {
      const playerStatus = room.gameState.playerBanStatus[playerId];
      const playerTeam = playerStatus.team;
      
      // 이미 해당 팀이 밴한 챔피언을 제외한 목록
      const teamBannedChampions = playerTeam === 'team1' ? team1BannedChampions : team2BannedChampions;
      const availableChampions = champions.filter(c => !teamBannedChampions.includes(c));
      
      if (availableChampions.length > 0) {
        // 랜덤 챔피언 선택
        const randomIndex = Math.floor(Math.random() * availableChampions.length);
        const selectedChampion = availableChampions[randomIndex];
        
        // 밴 상태 업데이트
        playerStatus.champion = selectedChampion;
        playerStatus.completed = true;
        
        // 팀별 밴 목록에 추가
        if (playerTeam === 'team1') {
          team1BannedChampions.push(selectedChampion);
        } else if (playerTeam === 'team2') {
          team2BannedChampions.push(selectedChampion);
        }
        
        // 자동 밴 이벤트 전송
        io.to(room.id).emit('ban-confirmed', {
          playerId: playerId,
          champion: selectedChampion,
          team: playerTeam,
          auto: true
        });
        
        console.log(`자동 밴 처리: ${playerStatus.nickname}(${playerTeam})이(가) ${selectedChampion}을(를) 밴했습니다.`);
      }
    });
    
    // 모든 자동 밴 처리 후 밴 단계 종료
    completeBanPhase(room);
  }

  // 밴 단계 완료
  function completeBanPhase(room) {
    // 밴 타이머 제거
    if (room.banTimer) {
      clearTimeout(room.banTimer);
      room.banTimer = null;
    }
    
    // 게임 단계를 플레이로 변경
    room.gameState.phase = GamePhase.PLAY;
    
    // 팀별 플레이어 목록
    const team1Players = room.gameState.team1.filter(p => p !== null);
    const team2Players = room.gameState.team2.filter(p => p !== null);
    
    // 팀별 밴 챔피언 목록
    const team1Bans = [];
    const team2Bans = [];
    const allBannedChampions = [];
    
    // 플레이어 밴 상태에서 밴 챔피언 수집
    Object.values(room.gameState.playerBanStatus).forEach(player => {
      if (player.champion) {
        allBannedChampions.push(player.champion);
        
        if (player.team === 'team1') {
          team1Bans.push(player.champion);
        } else if (player.team === 'team2') {
          team2Bans.push(player.champion);
        }
      }
    });
    
    // 밴 목록 저장
    room.gameState.bannedChampions = allBannedChampions;
    
    // 밴 단계 완료 이벤트 전송
    io.to(room.id).emit('ban-phase-complete', {
      team1Bans,
      team2Bans,
      allBannedChampions
    });
    
    // 게임 시작
    startGame(room);
  }

  // 게임 시작 (플레이 단계)
  function startGame(room) {
    // 게임 단계를 플레이로 설정
    room.gameState.phase = GamePhase.PLAY;
    
    // 팀별로 챔피언 할당
    const team1Players = room.gameState.team1.filter(p => p !== null);
    const team2Players = room.gameState.team2.filter(p => p !== null);
    const waitingPlayers = room.gameState.waiting.filter(p => p !== null);

    // 팀1 챔피언 할당
    team1Players.forEach(player => {
      if (player) {
        player.champion = getRandomChampion(team1Players, [...room.gameState.team1Champions, ...room.gameState.bannedChampions]);
        // 리롤 횟수는 초기화하지 않음
      }
    });

    // 팀2 챔피언 할당
    team2Players.forEach(player => {
      if (player) {
        player.champion = getRandomChampion(team2Players, [...room.gameState.team2Champions, ...room.gameState.bannedChampions]);
        // 리롤 횟수는 초기화하지 않음
      }
    });

    // 대기실 플레이어 챔피언 할당
    waitingPlayers.forEach(player => {
      if (player) {
        player.champion = getRandomChampion(waitingPlayers, [...room.gameState.bannedChampions]);
        // 리롤 횟수는 초기화하지 않음
      }
    });
    
    // 카운트다운 시작
    const countdownDuration = 120; // 2분
    io.to(room.id).emit('start-countdown', countdownDuration);
    
    // 카운트다운이 끝나면 스왑과 리롤 기능 비활성화
    setTimeout(() => {
      io.to(room.id).emit('countdown-finished');
    }, countdownDuration * 1000);
    
    // 게임 상태 전체 정보 전송 (팀 챔피언 리스트 포함)
    io.to(room.id).emit('game-state', room.gameState);
  }

  // 랜덤 팀 배정
  socket.on('random-assign-teams', () => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room || socket.id !== room.gameState.host) return;

    // 대기실에 있는 플레이어들 가져오기
    const waitingPlayers = room.gameState.waiting.filter(p => p !== null);
    if (waitingPlayers.length === 0) return;

    // 팀1과 팀2 초기화
    room.gameState.team1 = Array(5).fill(null);
    room.gameState.team2 = Array(5).fill(null);

    // 랜덤하게 플레이어 섞기
    const shuffledPlayers = [...waitingPlayers].sort(() => Math.random() - 0.5);

    // 플레이어를 팀1과 팀2에 배정 (각 팀 최대 5명)
    const team1Count = Math.min(5, Math.floor(shuffledPlayers.length / 2));
    const team2Count = Math.min(5, shuffledPlayers.length - team1Count);

    // 팀1에 배정
    for (let i = 0; i < team1Count; i++) {
      const player = shuffledPlayers[i];
      room.gameState.team1[i] = player;
      player.team = 'team1';
      player.index = i;
    }

    // 팀2에 배정
    for (let i = 0; i < team2Count; i++) {
      const player = shuffledPlayers[team1Count + i];
      room.gameState.team2[i] = player;
      player.team = 'team2';
      player.index = i;
    }

    // 대기실 비우기
    room.gameState.waiting = Array(10).fill(null);

    // 게임 상태 업데이트
    io.to(room.id).emit('game-state', room.gameState);
  });

  // 게임 초기화
  socket.on('reset-game', ({ winningTeam }) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room || socket.id !== room.gameState.host) return;

    console.log(`게임 초기화: 승리 팀 = ${winningTeam}`);

    // 모든 플레이어의 챔피언만 초기화 (리롤 횟수는 유지)
    room.gameState.players.forEach(player => {
      player.champion = null;
      
      // 대기실에 있는 플레이어는 승패 처리에서 제외
      if (player.team === 'waiting') {
        return;
      }
      
      // 승리/패배에 따른 리롤 보상 처리
      if (player.team !== winningTeam) {
        // 패배 처리
        if (player.stats) {
          player.stats.rerollCount = (player.stats.rerollCount || 0) + 2; // 패배 시 리롤 2회 추가
          player.stats.lose = (player.stats.lose || 0) + 1;
          console.log(`패배 처리: ${player.nickname} - 패배 ${player.stats.lose}회, 리롤 ${player.stats.rerollCount}회`);
        }
        
        // 리롤 횟수 추가 알림 전송
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.emit('reroll-bonus', {
            message: '패배 보상: 리롤 횟수 +2',
            newCount: player.stats ? player.stats.rerollCount : 2
          });
        }
      } else if (player.team === winningTeam) {
        // 승리 처리
        if (player.stats) {
          player.stats.rerollCount = (player.stats.rerollCount || 0) + 1; // 승리 시 리롤 1회 추가
          player.stats.win = (player.stats.win || 0) + 1;
          console.log(`승리 처리: ${player.nickname} - 승리 ${player.stats.win}회, 리롤 ${player.stats.rerollCount}회`);
        }
        
        // 리롤 횟수 추가 알림 전송
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.emit('reroll-bonus', {
            message: '승리 보상: 리롤 횟수 +1',
            newCount: player.stats ? player.stats.rerollCount : 1
          });
        }
      }
    });

    // 챔피언 리스트 초기화
    room.gameState.team1Champions = [];
    room.gameState.team2Champions = [];
    room.gameState.bannedChampions = []; // 밴 챔피언 목록도 초기화
    room.gameState.playerBanStatus = {}; // 플레이어 밴 상태 초기화
    room.gameState.phase = GamePhase.IDLE; // 게임 단계 초기화
    
    // 밴 타이머가 있다면 정지
    if (room.banTimer) {
      clearTimeout(room.banTimer);
      room.banTimer = null;
    }

    // 모든 플레이어를 대기실로 이동
    let waitingIndex = 0;
    room.gameState.waiting = Array(10).fill(null);
    room.gameState.team1 = Array(5).fill(null);
    room.gameState.team2 = Array(5).fill(null);

    room.gameState.players.forEach(player => {
      if (waitingIndex < 10) {
        room.gameState.waiting[waitingIndex] = player;
        player.team = 'waiting';
        player.index = waitingIndex;
        waitingIndex++;
      }
    });

    // 카운트다운 초기화 이벤트 전송
    io.to(room.id).emit('countdown-reset');
    
    // 모든 플레이어에게 챔피언 리스트 초기화 이벤트 전송
    io.to(room.id).emit('champion-list-update', []);

    // 게임 상태 전체 정보 전송
    io.to(room.id).emit('game-state', room.gameState);
  });

  // 리롤 요청
  socket.on('request-reroll', () => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    const allPlayers = [...room.gameState.team1, ...room.gameState.team2, ...room.gameState.waiting];
    const currentPlayer = allPlayers.find(p => p && p.id === socket.id);
    
    if (currentPlayer && currentPlayer.stats && currentPlayer.stats.rerollCount > 0) {
      // 현재 플레이어의 팀원들 찾기
      const teamPlayers = currentPlayer.team === 'team1' ? room.gameState.team1 :
                         currentPlayer.team === 'team2' ? room.gameState.team2 :
                         room.gameState.waiting;
      
      const teamChampions = currentPlayer.team === 'team1' ? room.gameState.team1Champions :
                           currentPlayer.team === 'team2' ? room.gameState.team2Champions :
                           [];
      
      // 밴된 챔피언도 제외하고 새로운 챔피언 할당
      const newChampion = getRandomChampion(teamPlayers, [...teamChampions, ...room.gameState.bannedChampions]);
      if (newChampion) {
        // 기존 챔피언을 팀 챔피언 리스트에 추가
        if (currentPlayer.champion) {
          if (currentPlayer.team === 'team1') {
            room.gameState.team1Champions.push(currentPlayer.champion);
          } else if (currentPlayer.team === 'team2') {
            room.gameState.team2Champions.push(currentPlayer.champion);
          }
        }

        currentPlayer.champion = newChampion;
        // 통계에서 리롤 카운트 차감
        currentPlayer.stats.rerollCount--;
        
        // 현재 플레이어에게만 리롤 횟수 업데이트
        socket.emit('reroll-update', currentPlayer.stats.rerollCount);
        
        // 같은 팀의 모든 플레이어에게 챔피언 리스트 업데이트
        const teamSockets = Array.from(room.players)
          .filter(playerId => {
            const player = room.gameState.players.get(playerId);
            return player && player.team === currentPlayer.team;
          })
          .map(playerId => io.sockets.sockets.get(playerId));

        if (currentPlayer.team === 'team1') {
          teamSockets.forEach(teamSocket => {
            teamSocket.emit('champion-list-update', room.gameState.team1Champions);
          });
        } else if (currentPlayer.team === 'team2') {
          teamSockets.forEach(teamSocket => {
            teamSocket.emit('champion-list-update', room.gameState.team2Champions);
          });
        }
        
        // 게임 상태 전체 정보 전송
        io.to(room.id).emit('game-state', room.gameState);
      }
    }
  });

  // 챔피언 스왑 요청
  socket.on('swap-champion', (targetChampion) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    const currentPlayer = room.gameState.players.get(socket.id);
    if (!currentPlayer || !currentPlayer.champion) return;

    // 현재 플레이어의 팀 챔피언 리스트 확인
    const teamChampions = currentPlayer.team === 'team1' ? room.gameState.team1Champions :
                         currentPlayer.team === 'team2' ? room.gameState.team2Champions :
                         [];

    // 선택한 챔피언이 팀 리스트에 있는지 확인
    const championIndex = teamChampions.indexOf(targetChampion);
    if (championIndex === -1) return;

    // 챔피언 스왑
    const oldChampion = currentPlayer.champion;
    currentPlayer.champion = targetChampion;
    teamChampions[championIndex] = oldChampion;

    // 스왑 성공 이벤트 전송
    socket.emit('champion-swapped', {
      oldChampion: oldChampion,
      newChampion: targetChampion
    });

    // 같은 팀의 모든 플레이어에게 챔피언 리스트 업데이트
    const teamSockets = Array.from(room.players)
      .filter(playerId => {
        const player = room.gameState.players.get(playerId);
        return player && player.team === currentPlayer.team;
      })
      .map(playerId => io.sockets.sockets.get(playerId));

    if (currentPlayer.team === 'team1') {
      teamSockets.forEach(teamSocket => {
        teamSocket.emit('champion-list-update', room.gameState.team1Champions);
      });
    } else if (currentPlayer.team === 'team2') {
      teamSockets.forEach(teamSocket => {
        teamSocket.emit('champion-list-update', room.gameState.team2Champions);
      });
    }

    // 게임 상태 업데이트
    io.to(room.id).emit('game-state', room.gameState);
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (room) {
      // 플레이어 제거
      room.players = room.players.filter(id => id !== socket.id);
      
      // 호스트가 나간 경우
      if (socket.id === room.gameState.host) {
        // 남은 플레이어가 있으면 첫 번째 플레이어를 호스트로 지정
        if (room.players.length > 0) {
          room.gameState.host = room.players[0];
          // 모든 플레이어의 호스트 상태 업데이트
          room.gameState.players.forEach(player => {
            player.isHost = player.id === room.players[0];
          });
          // 새 호스트에게 호스트 권한 알림
          io.to(room.players[0]).emit('host-changed', true);
        }
      }

      // 플레이어 정보 제거
      const player = room.gameState.players.get(socket.id);
      if (player) {
        // 플레이어 번호 해제 (닉네임이 "플레이어xx" 형식인 경우만)
        const nicknameMatch = player.nickname.match(/^플레이어(\d+)$/);
        if (nicknameMatch) {
          const playerNumber = parseInt(nicknameMatch[1]);
          room.gameState.usedPlayerNumbers.delete(playerNumber);
          console.log(`플레이어 번호 해제: ${playerNumber}`);
        }

        if (player.team && player.index !== null) {
          room.gameState[player.team][player.index] = null;
        }
        room.gameState.players.delete(socket.id);
      }

      // 방이 비었으면 삭제
      if (room.players.length === 0) {
        rooms.delete(room.id);
      } else {
        // 게임 상태 업데이트
        io.to(room.id).emit('game-state', room.gameState);
      }
    }
  });

  // 게임 상태 업데이트 및 브로드캐스트
  function updateGameState() {
    const state = {
      team1: gameState.team1.map(p => p ? {
        nickname: p.nickname,
        champion: p.champion,
        rerollCount: p.stats ? p.stats.rerollCount : 0
      } : null),
      team2: gameState.team2.map(p => p ? {
        nickname: p.nickname,
        champion: p.champion,
        rerollCount: p.stats ? p.stats.rerollCount : 0
      } : null),
      waiting: gameState.waiting.map(p => p ? {
        nickname: p.nickname,
        champion: p.champion,
        rerollCount: p.stats ? p.stats.rerollCount : 0
      } : null)
    };
    io.emit('game-state', state);
  }

  // 방 목록 업데이트
  function updateRoomList() {
    const roomList = Array.from(rooms.values()).map(room => ({
      id: room.id,
      name: room.name,
      players: room.players
    }));
    io.emit('room-list', roomList);
  }

  // 챔피언 밴 요청 처리
  socket.on('ban-champion', (data) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    // 밴 단계가 아니면 무시
    if (room.gameState.phase !== GamePhase.BAN) return;

    // 플레이어가 팀에 속해있는지 확인
    const player = room.gameState.players.get(socket.id);
    if (!player || (player.team !== 'team1' && player.team !== 'team2')) return;

    // 이미 밴을 완료한 플레이어인지 확인
    if (room.gameState.playerBanStatus[socket.id] && room.gameState.playerBanStatus[socket.id].completed) return;

    const championName = data.champion;
    const isAuto = data.auto || false;

    // 유효한 챔피언인지 확인
    if (!champions.includes(championName)) return;

    // 같은 팀이 이미 밴한 챔피언인지 확인
    const isBannedByTeam = Object.values(room.gameState.playerBanStatus)
      .some(p => p.team === player.team && p.champion === championName);
    
    if (isBannedByTeam) {
      // 같은 팀이 이미 밴한 챔피언인 경우 다른 챔피언을 선택하도록 함
      if (isAuto) {
        // 사용 가능한 챔피언 중에서 랜덤 선택
        // 이미 같은 팀이 밴한 챔피언은 제외
        const teamBannedChampions = Object.values(room.gameState.playerBanStatus)
          .filter(p => p.team === player.team && p.champion)
          .map(p => p.champion);
        
        const availableChampions = champions.filter(c => !teamBannedChampions.includes(c));
        
        if (availableChampions.length > 0) {
          const randomIndex = Math.floor(Math.random() * availableChampions.length);
          const newChampion = availableChampions[randomIndex];
          
          room.gameState.playerBanStatus[socket.id].champion = newChampion;
          room.gameState.playerBanStatus[socket.id].completed = true;
          
          // 자동 밴에 대한 밴 확정 이벤트 전송
          io.to(room.id).emit('ban-confirmed', {
            playerId: socket.id,
            champion: newChampion,
            team: player.team,
            auto: true
          });
        }
      }
      return;
    }

    // 플레이어 밴 상태 업데이트
    room.gameState.playerBanStatus[socket.id].champion = championName;
    room.gameState.playerBanStatus[socket.id].completed = true;

    // 모든 플레이어에게 밴 상태 업데이트 전송
    io.to(room.id).emit('player-ban-status', room.gameState.playerBanStatus);

    // 밴 확정 이벤트 전송 (UI 업데이트를 위해)
    io.to(room.id).emit('ban-confirmed', {
      playerId: socket.id,
      champion: championName,
      team: player.team
    });

    // 모든 플레이어가 밴을 완료했는지 확인
    const allCompleted = Object.values(room.gameState.playerBanStatus)
                              .every(p => p.completed);
    
    if (allCompleted) {
      // 모든 플레이어가 밴을 완료했으면 밴 단계 종료 및 게임 시작
      completeBanPhase(room);
    }
  });

  // 플레이어 선택 중인 챔피언 업데이트 처리
  socket.on('selecting-ban-champion', (championName) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    // 밴 단계가 아니면 무시
    if (room.gameState.phase !== GamePhase.BAN) return;

    // 플레이어가 팀에 속해있는지 확인
    const player = room.gameState.players.get(socket.id);
    if (!player || (player.team !== 'team1' && player.team !== 'team2')) return;

    // 이미 밴을 완료한 플레이어인지 확인
    if (room.gameState.playerBanStatus[socket.id] && room.gameState.playerBanStatus[socket.id].completed) return;

    // 플레이어가 선택 중인 챔피언 업데이트
    if (!room.gameState.playerBanStatus[socket.id]) {
      room.gameState.playerBanStatus[socket.id] = {
        nickname: player.nickname,
        team: player.team,
        completed: false
      };
    }

    // 선택 중인 챔피언 설정 (null이면 선택 취소)
    room.gameState.playerBanStatus[socket.id].selectingChampion = championName;

    // 모든 플레이어에게 선택 중인 챔피언 정보 전송
    io.to(room.id).emit('player-selecting-champion', {
      playerId: socket.id,
      champion: championName
    });
  });

  // 챔피언 밴 해제 요청 처리
  socket.on('unban-champion', (championName) => {
    const room = Array.from(rooms.values()).find(r => r.players.includes(socket.id));
    if (!room) return;

    // 게임이 시작되었으면 밴 해제 불가
    if ([...room.gameState.team1, ...room.gameState.team2].some(p => p && p.champion)) {
      return;
    }

    // 호스트만 밴 해제 가능
    if (socket.id !== room.gameState.host) {
      return;
    }

    // 밴 리스트에서 제거
    const index = room.gameState.bannedChampions.indexOf(championName);
    if (index !== -1) {
      room.gameState.bannedChampions.splice(index, 1);
    }

    // 게임 상태 업데이트
    io.to(room.id).emit('game-state', room.gameState);
  });
});

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
          message: '댓글이 작성되었어요! ✨'
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

app.get('/lol', (req, res) => {
  res.render('lol', { champions });
});

// 서버 시작
server.listen(port, '0.0.0.0', () => {
  console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
});