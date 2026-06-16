const {SlashCommandBuilder,EmbedBuilder} = require('discord.js')

module.exports = {
   Data: NewSlashCommandBuilder()
   .setName('LoaRequest')
   .setDescription('[DEV] Request Leave of abscense')
   .addUserOption(option =>
    option.setName('user')
        .setDescription('Выберите пользователя')
        .setRequired(true)
)
.addStringOption(option =>
    option.setName('loa_time')
        .setDescription('Укажите время отсутствия (например: 3 дня, до понедельника)')
        .setRequired(true)
),
}