import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Update via Steam and start the Ark: Survival Ascended server.'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Gracefully stop the Ark: Survival Ascended server (saves the world first).'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check whether the Ark server is currently running.'),
  new SlashCommandBuilder()
    .setName('destroywilddinos')
    .setDescription('Wipe all wild dinos (tamed dinos are unaffected). Forces fresh spawns.'),
].map((c) => c.toJSON());

// Allow running this file directly to (re)register guild commands.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    console.log('Registering guild slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands },
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}
