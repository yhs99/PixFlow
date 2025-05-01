const { REST, Routes } = require('discord.js');
const fs = require('fs');
const envPath = process.env.NODE_ENV === 'production' ? './bot/.env.production' : './bot/.env';
require('dotenv').config({ path: envPath });

const commands = [];
const commandFiles = fs.readdirSync('./bot/commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
const clientId = process.env.CLIENT_ID;

// GUILD_ID를 쉼표로 구분된 문자열로부터 배열로 변환
const guildIds = process.env.GUILD_ID ? process.env.GUILD_ID.split(',').map(id => id.trim()) : [];

(async () => {
  try {
    // ✅ 기존 전역 명령어 전체 삭제
    console.log('🗑️ 전역 명령어 전체 삭제 중...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ 전역 명령어 삭제 완료!');

    // 서버별 명령어 등록이 지정된 경우
    if (guildIds.length > 0) {
      console.log(`📋 ${guildIds.length}개의 서버에 명령어 등록을 시작합니다...`);
      
      // 각 서버에 명령어 등록
      for (const guildId of guildIds) {
        console.log(`🔹 서버 ID: ${guildId}에 명령어 등록 중...`);
        try {
          // 해당 서버의 기존 명령어 삭제
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
          
          // 새 명령어 등록
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
          console.log(`✅ 서버 ID: ${guildId}에 명령어 등록 완료!`);
        } catch (guildError) {
          console.error(`❌ 서버 ID: ${guildId}에 명령어 등록 중 오류:`, guildError);
        }
      }
      
      console.log('✅ 모든 서버에 명령어 등록 작업 완료!');
    } else {
      // 서버 ID가 지정되지 않은 경우 전역 명령어로 등록
      console.log('🌐 전역 명령어로 등록합니다...');
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ 전역 명령어 등록 완료!');
    }
  } catch (error) {
    console.error('❌ 명령어 등록 중 오류:', error);
  }
})();