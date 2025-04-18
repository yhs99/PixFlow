const { REST, Routes } = require('discord.js');
const fs = require('fs');
const envPath = process.env.NODE_ENV === 'production' ? 'bot/.env.production' : 'bot/.env';
require('dotenv').config({ path: envPath });

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
const clientId = process.env.CLIENT_ID;

(async () => {
  try {
    // ✅ 기존 명령어 전체 삭제
    console.log('🗑️ 전역 명령어 전체 삭제 중...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ 전역 명령어 삭제 완료!');

    // ✅ 새 명령어 등록
    console.log('📦 새 명령어 등록 중...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ 명령어 등록 완료!');
  } catch (error) {
    console.error('❌ 명령어 등록 중 오류:', error);
  }
})();