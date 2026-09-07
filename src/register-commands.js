import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';

// Every command takes a `server` option whose choices come straight from
// config.json, so adding a server to the config adds it to the Discord
// pickers on the next boot without touching this file.
const serverChoices = config.serverNames.map((name) => ({
  name: `${name} — ${config.servers[name].label}`,
  value: name,
}));

const withServer = (builder, { required = true, description = 'Which server.' } = {}) =>
  builder.addStringOption((o) =>
    o.setName('server').setDescription(description).setRequired(required).addChoices(...serverChoices),
  );

export const commands = [
  // No server option: these two describe the whole bot.
  new SlashCommandBuilder().setName('help').setDescription('Explain what this bot can do.'),
  new SlashCommandBuilder()
    .setName('servers')
    .setDescription('List the game servers this bot manages.'),
  withServer(
    new SlashCommandBuilder().setName('start').setDescription('Update via Steam and start a game server.'),
  ),
  withServer(
    new SlashCommandBuilder().setName('stop').setDescription('Gracefully stop a game server (saves first).'),
  ),
  withServer(
    new SlashCommandBuilder().setName('status').setDescription('Check whether a game server is running.'),
    { required: false, description: 'Which server. Omit to show every configured server.' },
  ),
  // Custom per-game commands, e.g. /command server:ark name:destroywilddinos.
  // The `name` choices are per-server, so they are supplied by autocomplete
  // rather than baked in here.
  withServer(
    new SlashCommandBuilder()
      .setName('command')
      .setDescription('Run one of a server’s configured admin commands.'),
  )
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Which command to run (depends on the server).')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('args').setDescription('Optional extra text appended to the command.').setRequired(false),
    ),
  // NOTE: there is deliberately no raw-RCON command. Everything RCON-related
  // reaches the servers through the per-server `commands` whitelist in
  // config.json, so Discord users can only run what the config allows.
].map((c) => c.toJSON());

// Allow running this file directly to (re)register guild commands.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    console.log('Registering guild slash commands...');
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
      body: commands,
    });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}
