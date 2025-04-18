const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');
const path = require('path');
const { isAllowedCommunity } = require('./db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// 🔹 명령어 등록
client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
}

// 🔹 봇 준비 완료
client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// 🔹 슬래시 명령어 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`❌ 명령어 실행 오류:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ 명령어 실행 중 오류 발생',
        ephemeral: true
      });
    }
  }
});

// 🔹 이미지 메시지 업로드 처리
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.attachments.size) return;
  if (!message.channel.parent) return;

  const parentId = message.channel.parentId;
  const allowed = await isAllowedCommunity(parentId);
  if (!allowed) return;

  const parentName = (message.channel.parent.name).replaceAll(" ", "");
  const channelName = (message.channel.name).replaceAll(" ", "");

  const year = parentName.match(/\d{4}/)?.[0];
  const month = channelName.match(/\d{1,2}/)?.[0]?.padStart(2, '0');
  console.log(parentName);
  if(year === undefined && parentId == '1361844061354459349') {
    year = 2025;
  }else if (year === undefined && parentId == '1361842728589070477') {
    year = 2024;
  }
  const images = message.attachments
    .filter(att => att.contentType?.startsWith('image/'))
    .map(att => ({ url: att.url, name: att.name || 'upload.jpg' }));

  if (images.length === 0) return;
  if (images.length > 10) {
    await message.reply('❌ 최대 10개의 이미지만 업로드할 수 있어요.');
    return;
  }

  const form = new FormData();
  if(isNumber(year) && month === undefined) {
    const date = new Date();
    const month = (date.getMonth() + 1).toString().match(/\d{1,2}/)?.[0]?.padStart(2, '0');
    form.append('created_at', `${date.getFullYear()}-${month}-01 00:00:00`);
    form.append('category', channelName);
  }else {
    form.append('created_at', `${year}-${month}-01 00:00:00`);
    form.append('category', '');
  }
  form.append('description', message.content || '');
  const tempFiles = [];
    try {
        console.log('🕓 이미지 업로드 중입니다...')
        const reply = await message.reply('🕓 이미지 업로드 중입니다...');
        // 이미지 각각 다운로드하고 form에 첨부
        for (let i = 0; i < images.length; i++) {
        const { url, name } = images[i];
        const tempPath = path.join(__dirname, `temp_${i}_${name}`);
        tempFiles.push(tempPath);

        const writer = fs.createWriteStream(tempPath);
        await new Promise((resolve, reject) => {
            https.get(url, response => {
            response.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            });
        });

        form.append('images', fs.createReadStream(tempPath), name);
        }
        // axios 전송
        const response = await axios.post(process.env.API_ENDPOINT, form, {
        headers: form.getHeaders()
        });

        await reply.edit(`✅ ${response.data.message}`);
        console.log('✅ 이미지 업로드 완료:', response.data.message);
    } catch (err) {
        console.error('❌ 이미지 업로드 실패:', err.message);
        await reply.edit(`❌ 이미지 업로드에 실패했어요..`);
    } finally {
        // 임시 파일 정리
        for (const file of tempFiles) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}
});

function isNumber(str) {
  return !isNaN(str);
}

client.login(process.env.TOKEN);
