import { Client, GatewayIntentBits, Routes, REST, Events } from 'discord.js';
import { config } from './config.js';
import { commands } from './register-commands.js';
import { startServer, stopServer, updateServer, isRunning, sendRconCommand, serverInfo } from './arkServer.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Serialize start/stop so two people can't fire them at once.
let busy = false;

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Register guild commands on boot so deploys stay in sync.
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands },
    );
    console.log('Slash commands synced.');
  } catch (err) {
    console.error('Command sync failed:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Hard restriction: only the configured channel may control the server.
  if (interaction.channelId !== config.discord.allowedChannelId) {
    await interaction.reply({
      content: 'This command can only be used in the designated server-control channel.',
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await interaction.deferReply();
      const up = await isRunning();
      await interaction.editReply(
        up
          ? `🟢 **Online** — "${serverInfo.sessionName}" (${serverInfo.map}, port ${serverInfo.port})`
          : '🔴 **Offline** — the server is not running.',
      );
      return;
    }

    if (commandName === 'start') {
      if (busy) {
        await interaction.reply({ content: '⏳ Another start/stop operation is already in progress.', ephemeral: true });
        return;
      }
      busy = true;
      await interaction.deferReply();
      try {
        if (await isRunning()) {
          await interaction.editReply('🟢 Server is already running.');
          return;
        }
        await interaction.editReply('📥 Checking for updates via Steam… (this can take a while)');
        const updateSummary = await updateServer();
        await interaction.editReply(`✅ ${updateSummary}\n🚀 Starting the server…`);
        const { pid } = await startServer();
        await interaction.editReply(
          `🟢 **Server started!** "${serverInfo.sessionName}" (${serverInfo.map}, port ${serverInfo.port}, PID ${pid}). Give it a couple minutes to appear in the server list.`,
        );
      } finally {
        busy = false;
      }
      return;
    }

    if (commandName === 'stop') {
      if (busy) {
        await interaction.reply({ content: '⏳ Another start/stop operation is already in progress.', ephemeral: true });
        return;
      }
      busy = true;
      await interaction.deferReply();
      try {
        if (!(await isRunning())) {
          await interaction.editReply('🔴 Server is already stopped.');
          return;
        }
        await interaction.editReply('💾 Saving world and shutting down…');
        const { method } = await stopServer();
        const note = method.startsWith('taskkill') ? ' (RCON unavailable — force stopped)' : '';
        await interaction.editReply(`🔴 **Server stopped.**${note}`);
      } finally {
        busy = false;
      }
      return;
    }
    if (commandName === 'destroywilddinos') {
      await interaction.deferReply();
      const reply = await sendRconCommand('DestroyWildDinos');
      await interaction.editReply(
        `🦖💥 **Wild dinos destroyed.** Fresh spawns will repopulate shortly.${reply?.trim() ? `\n\`${reply.trim()}\`` : ''}`,
      );
      return;
    }
  } catch (err) {
    console.error(`Error handling /${commandName}:`, err);
    const msg = `❌ ${err.message || 'Something went wrong.'}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(config.discord.token);
