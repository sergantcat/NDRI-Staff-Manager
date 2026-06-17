require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  REST,
  Routes,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  const commandData = command.data || command.Data;

  if (commandData?.name && typeof command.execute === 'function') {
    client.commands.set(commandData.name, command);
  }
}

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId || !guildId) {
    throw new Error('DISCORD_TOKEN, CLIENT_ID, and GUILD_ID must be set in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const payload = client.commands.map(command => (command.data || command.Data).toJSON());

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if (!command) {
      return;
    }

    await command.execute(interaction);
    return;
  }

  for (const command of client.commands.values()) {
    if (typeof command.handleInteraction === 'function') {
      const handled = await command.handleInteraction(interaction);

      if (handled) {
        return;
      }
    }
  }
});

registerCommands()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
