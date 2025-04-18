const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { addAllowedCommunity } = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('카테고리등록')
    .setDescription('이미지 업로드 허용 카테고리를 추가합니다.')
    .addChannelOption(option =>
      option
        .setName('카테고리')
        .setDescription('업로드 등록할 카테고리 채널')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    ),

  async execute(interaction) {
    console.log('카테고리등록 실행');
    try {
      const category = interaction.options.getChannel('카테고리');

      if (!category) {
        return await interaction.reply({
          content: '❌ 채널 정보를 가져오지 못했습니다.',
          ephemeral: true
        });
      }

      const added = await addAllowedCommunity(category.id);
      await interaction.reply(
        added
          ? `✅ 카테고리 <#${category.id}> 가 등록되었습니다.`
          : `ℹ️ 이미 등록된 카테고리입니다.`
      );
    } catch (error) {
      console.error('❌ /카테고리등록 실행 중 오류:', error);
      await interaction.reply({
        content: '🚨 카테고리 추가 중 오류가 발생했습니다. 콘솔을 확인해주세요.',
        ephemeral: true
      });
    }
  }
};
