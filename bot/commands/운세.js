const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('운세')
    .setDescription('수비학에 근거한 당신의 운세를 알려드립니다.')
    .addStringOption(option => 
      option
        .setName('생년월일')
        .setDescription('당신의 생년월일을 입력하세요 (예: 19901210)')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const birthdate = interaction.options.getString('생년월일');
      
      // 입력값 검증
      if (!isValidBirthdate(birthdate)) {
        await interaction.editReply({
          content: '❌ 생년월일 형식이 올바르지 않습니다. YYYYMMDD 형식으로 입력해주세요 (예: 19901210).'
        });
        return;
      }
      
      // 수비학 운명수 계산
      const destinyNumber = calculateDestinyNumber(birthdate);
      
      // ChatGPT API 호출
      const fortune = await getFortuneFromChatGPT(destinyNumber, birthdate);
      
      // 운세 정보를 파싱하여 각 영역별로 분리
      const fortuneSections = parseFortune(fortune);
      
      // Embed 메시지 생성
      const embed = createFortuneEmbed(destinyNumber, fortuneSections);
      
      await interaction.editReply({
        embeds: [embed]
      });
    } catch (error) {
      console.error('❌ /운세 명령어 실행 중 오류:', error);
      await interaction.editReply('⚠️ 운세를 불러오는 중 오류가 발생했습니다.');
    }
  }
};

// 생년월일 유효성 검사
function isValidBirthdate(birthdate) {
  // YYYYMMDD 형식의 8자리 숫자인지 확인
  if (!/^\d{8}$/.test(birthdate)) {
    return false;
  }
  
  const year = parseInt(birthdate.substring(0, 4));
  const month = parseInt(birthdate.substring(4, 6));
  const day = parseInt(birthdate.substring(6, 8));
  
  // 날짜 유효성 검사
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if ((month === 4 || month === 6 || month === 9 || month === 11) && day > 30) return false;
  if (month === 2) {
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    if (day > (isLeapYear ? 29 : 28)) return false;
  }
  
  return true;
}

// 수비학 운명수 계산
function calculateDestinyNumber(birthdate) {
  // 모든 숫자를 더함 (예: 19901210 -> 1+9+9+0+1+2+1+0 = 23 -> 2+3 = 5)
  let sum = 0;
  for (let i = 0; i < birthdate.length; i++) {
    sum += parseInt(birthdate[i]);
  }
  
  // 두 자리 이상인 경우 한 자리가 될 때까지 각 자릿수를 계속 더함
  while (sum > 9) {
    let tempSum = 0;
    while (sum > 0) {
      tempSum += sum % 10;
      sum = Math.floor(sum / 10);
    }
    sum = tempSum;
  }
  
  return sum;
}

// 운세 텍스트를 영역별로 파싱
function parseFortune(fortune) {
  const sections = {
    '전체운': '',
    '금전운': '',
    '재물운': '',
    '연애운': ''
  };
  
  let currentSection = '';
  const lines = fortune.split('\n');
  
  for (const line of lines) {
    // 새로운 섹션 시작 확인
    if (line.includes('전체운') || line.toLowerCase().includes('오늘의 전체운')) {
      currentSection = '전체운';
      sections[currentSection] += line.replace(/^.*전체운:?/i, '').trim();
      continue;
    } else if (line.includes('금전운') || line.toLowerCase().includes('오늘의 금전운')) {
      currentSection = '금전운';
      sections[currentSection] += line.replace(/^.*금전운:?/i, '').trim();
      continue;
    } else if (line.includes('재물운') || line.toLowerCase().includes('오늘의 재물운')) {
      currentSection = '재물운';
      sections[currentSection] += line.replace(/^.*재물운:?/i, '').trim();
      continue;
    } else if (line.includes('연애운') || line.toLowerCase().includes('오늘의 연애운')) {
      currentSection = '연애운';
      sections[currentSection] += line.replace(/^.*연애운:?/i, '').trim();
      continue;
    }
    
    // 현재 섹션에 내용 추가
    if (currentSection && line.trim()) {
      sections[currentSection] += ' ' + line.trim();
    }
  }
  
  return sections;
}

// 운세 Embed 메시지 생성
function createFortuneEmbed(destinyNumber, fortuneSections) {
  const currentDate = new Date();
  const formattedDate = `${currentDate.getFullYear()}년 ${currentDate.getMonth() + 1}월 ${currentDate.getDate()}일`;
  
  // 운명수에 따른 색상 설정
  const colors = {
    1: 0xFF0000, // 빨강
    2: 0xFFA500, // 주황
    3: 0xFFFF00, // 노랑
    4: 0x00FF00, // 초록
    5: 0x0000FF, // 파랑
    6: 0x4B0082, // 남색
    7: 0x9400D3, // 보라
    8: 0xA0522D, // 갈색
    9: 0xFFFFFF  // 흰색
  };
  
  const embed = new EmbedBuilder()
    .setColor(colors[destinyNumber] || 0x0099FF)
    .setTitle(`✨ 운명수 ${destinyNumber}번의 오늘 운세`)
    .setDescription(`${formattedDate}의 운세입니다.`)
    .setThumbnail(`https://via.placeholder.com/150/FFDD00/000000?text=${destinyNumber}`)
    .setTimestamp();
  
  // 각 섹션을 필드로 추가
  for (const [title, content] of Object.entries(fortuneSections)) {
    if (content) {
      embed.addFields({ name: `🔮 ${title}`, value: content || '정보가 없습니다.', inline: false });
    }
  }
  
  // 운명수 의미 설명 추가
  const numberMeanings = {
    1: '리더십, 독립성, 창의성',
    2: '협력, 균형, 조화',
    3: '표현력, 낙관주의, 창의성',
    4: '안정성, 성실함, 현실주의',
    5: '자유, 변화, 모험',
    6: '책임감, 사랑, 조화',
    7: '분석력, 지혜, 내면의 성찰',
    8: '성취, 물질적 풍요, 권위',
    9: '완성, 관용, 봉사'
  };
  
  embed.setFooter({ 
    text: `운명수 ${destinyNumber}번: ${numberMeanings[destinyNumber] || ''}` 
  });
  
  return embed;
}

// ChatGPT API를 사용하여 운세 가져오기
async function getFortuneFromChatGPT(destinyNumber, birthdate) {
  try {
    const currentDate = new Date();
    const formattedDate = `${currentDate.getFullYear()}년 ${currentDate.getMonth() + 1}월 ${currentDate.getDate()}일`;
    
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: '당신은 전문적인 수비학(Numerology) 운세 해석가입니다. 생년월일과 운명수를 기반으로 상세하고 개인화된 운세를 제공해주세요. 다른 설명은 하지말고 운세에 대한 설명만 제공해주세요. 긍정적이고 희망적인 메시지를 포함하되, 현실적인 조언도 함께 제공해주세요.'
          },
          {
            role: 'user',
            content: `오늘은 ${formattedDate}입니다. 생년월일 ${birthdate}를 가진 사람의 운명수를 계산하고 그 사람의 오늘 운세를 알려주세요. 오직 운세만 다음 영역별로 알려주세요: 전체운, 금전운, 재물운, 연애운`
          }
        ],
        temperature: 0.7,
        max_tokens: 700
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );
    
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('ChatGPT API 호출 중 오류:', error);
    return '운세 정보를 불러오는 중 오류가 발생했습니다. 나중에 다시 시도해주세요.';
  }
} 