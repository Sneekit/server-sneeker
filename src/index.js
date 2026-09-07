import { Client, GatewayIntentBits, Routes, REST, Events } from 'discord.js';
import { config, getServer } from './config.js';
import { commands } from './register-commands.js';
import {
  startServer,
  stopServer,
  updateServer,
  isRunning,
  sendRconCommand,
  formatRconReply,
  getPlayerCount,
  describeServer,
} from './serverManager.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Serialize start/stop per server so two people can't fire them at once.
// Keyed by server name: starting Palworld must not block starting Ark.
const busy = new Map();
const isBusy = (server) => busy.get(server.name) === true;
const setBusy = (server, value) => busy.set(server.name, value);

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Managing ${config.serverNames.length} server(s): ${config.serverNames.join(', ')}`);

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

  // Arm one idle auto-shutdown watcher per server that wants one.
  for (const name of config.serverNames) {
    const server = config.servers[name];
    if (!server.autoShutdown.enabled) continue;
    setInterval(() => autoShutdownTick(server), server.autoShutdown.pollSeconds * 1000);
    console.log(
      `[${name}] Auto-shutdown armed: stop after ${server.autoShutdown.idleMinutes} min idle (poll every ${server.autoShutdown.pollSeconds}s).`,
    );
  }
});

// ---- Autocomplete: per-server command names for /command -------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (interaction.commandName !== 'command') return;

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
    await interaction.respond([]);
    return;
  }

  let server;
  try {
    server = getServer(interaction.options.getString('server'));
  } catch {
    // No server picked yet — nothing sensible to suggest.
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim().toLowerCase();
  const matches = Object.values(server.commands)
    .filter((c) => c.name.includes(query))
    .slice(0, 25) // Discord's hard cap on autocomplete choices.
    .map((c) => ({ name: `${c.name} — ${c.description}`.slice(0, 100), value: c.name }));
  await interaction.respond(matches);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Hard restriction: only the configured channel may control the servers.
  if (interaction.channelId !== config.discord.allowedChannelId) {
    await interaction.reply({
      content: 'This command can only be used in the designated server-control channel.',
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  try {
    if (commandName === 'help') {
      // Ephemeral: help is a personal lookup, no need to clutter the channel.
      await interaction.reply({ content: helpText(), ephemeral: true });
      return;
    }

    if (commandName === 'servers') {
      // Pure config lookup — no process or RCON calls, so no deferral needed.
      await interaction.reply({ content: serversText(), ephemeral: true });
      return;
    }

    if (commandName === 'status') {
      await interaction.deferReply();
      const requested = interaction.options.getString('server');
      const names = requested ? [getServer(requested).name] : config.serverNames;
      const lines = await Promise.all(names.map((n) => statusLine(config.servers[n])));
      await interaction.editReply(lines.join('\n\n'));
      return;
    }

    if (commandName === 'start') {
      const server = getServer(interaction.options.getString('server'));
      if (isBusy(server)) {
        await interaction.reply({
          content: `⏳ Another start/stop operation for **${server.name}** is already in progress.`,
          ephemeral: true,
        });
        return;
      }
      setBusy(server, true);
      await interaction.deferReply();
      try {
        if (await isRunning(server)) {
          await interaction.editReply(`🟢 **${server.name}** is already running.`);
          return;
        }
        await interaction.editReply(
          `📥 **${server.name}** — checking for updates via Steam… (this can take a while)`,
        );
        const updateSummary = await updateServer(server);
        await interaction.editReply(`✅ ${updateSummary}\n🚀 Starting **${server.name}**…`);
        const { pid, settingsChanged } = await startServer(server);
        const settingsNote = settingsChanged.length
          ? `\n⚙️ Synced settings file: ${settingsChanged.join(', ')}`
          : '';
        await interaction.editReply(
          `🟢 **${server.name} started!** "${server.sessionName}" (${describeServer(server).join(', ')}, PID ${pid})${settingsNote}\nGive it a couple minutes to appear in the server list.`,
        );
      } finally {
        setBusy(server, false);
      }
      return;
    }

    if (commandName === 'stop') {
      const server = getServer(interaction.options.getString('server'));
      if (isBusy(server)) {
        await interaction.reply({
          content: `⏳ Another start/stop operation for **${server.name}** is already in progress.`,
          ephemeral: true,
        });
        return;
      }
      setBusy(server, true);
      await interaction.deferReply();
      try {
        if (!(await isRunning(server))) {
          await interaction.editReply(`🔴 **${server.name}** is already stopped.`);
          return;
        }
        await interaction.editReply(`💾 **${server.name}** — saving and shutting down…`);
        const { method } = await stopServer(server);
        const note = method.startsWith('taskkill') ? ' (RCON unreachable — force killed)' : '';
        await interaction.editReply(`🔴 **${server.name} stopped.**${note}`);
      } finally {
        setBusy(server, false);
      }
      return;
    }

    if (commandName === 'command') {
      const server = getServer(interaction.options.getString('server'));
      const name = interaction.options.getString('name').trim().toLowerCase();
      const entry = server.commands[name];
      if (!entry) {
        const available = Object.keys(server.commands);
        await interaction.reply({
          content: available.length
            ? `❌ **${server.name}** has no command "${name}". Available: ${available.join(', ')}.`
            : `❌ **${server.name}** has no configured commands. Add them under servers.${server.name}.commands in config.json.`,
          ephemeral: true,
        });
        return;
      }

      const args = (interaction.options.getString('args') ?? '').trim();
      if (entry.args?.required && !args) {
        await interaction.reply({
          content: `❌ \`${name}\` needs the \`args\` option: ${entry.args.description}`,
          ephemeral: true,
        });
        return;
      }
      if (args && !entry.args) {
        await interaction.reply({
          content: `❌ \`${name}\` does not take arguments — leave \`args\` empty.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      const full = args ? `${entry.rcon} ${args}` : entry.rcon;
      const reply = await sendRconCommand(server, full);
      await interaction.editReply(
        `🎮 **${server.name}** — sent \`${full}\`. ${formatRconReply(reply)}`,
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

/** Clamp a reply to Discord's hard 2000-character message limit. */
function clamp(text) {
  return text.length <= 2000 ? text : `${text.slice(0, 1900).trimEnd()}\n… (see the README for the rest)`;
}

/**
 * Build the /servers catalogue: what exists and how it's configured. Reads
 * config only — deliberately no process or RCON checks, so it answers
 * instantly. /status is the command for live state.
 */
function serversText() {
  const lines = [`**${config.serverNames.length} server(s) configured:**`];

  for (const name of config.serverNames) {
    const s = config.servers[name];

    // Identity line: name, session name, and the shape of the world.
    const facts = [`"${s.sessionName}"`];
    if (s.map) facts.push(s.map);
    facts.push(`up to ${s.maxPlayers} players`, `port ${s.port}`);

    // Details line: what's installed and how it behaves.
    const details = [];
    if (s.mods.length) details.push(`${s.mods.length} mod(s)`);
    const commandNames = Object.keys(s.commands);
    details.push(
      commandNames.length ? `commands: ${commandNames.map((c) => `\`${c}\``).join(', ')}` : 'no custom commands',
    );
    details.push(
      s.autoShutdown.enabled
        ? `auto-stops after ${s.autoShutdown.idleMinutes} min idle`
        : 'auto-shutdown off',
    );

    lines.push('', `**${name}** — ${s.label}`, `  ${facts.join(' · ')}`, `  ${details.join(' · ')}`);
  }

  lines.push('', '_`/status` shows which are online · `/help` explains the commands._');
  return clamp(lines.join('\n'));
}

/**
 * Build the /help message from the live config, so it can never drift out of
 * sync with the servers and commands actually available.
 */
function helpText() {
  const names = config.serverNames;
  const list = names.map((n) => `\`${n}\``).join(', ');

  const lines = [
    '**Server Sneeker** — starts and stops the game servers from Discord.',
    '',
    `Every command asks which server to act on. Configured right now: ${list}.`,
    '',
    '**The basics**',
    `\`/start server:<name>\` — Updates the server through Steam, then launches it. Takes a few minutes; the reply keeps updating as it goes, so give it time rather than running it twice. Once it says started, allow another couple of minutes before it shows up in the in-game server list.`,
    `\`/stop server:<name>\` — Saves the world, then shuts the server down cleanly. Safe to use with players online — they'll be disconnected, but nothing is lost.`,
    `\`/status\` — Shows every server: online or offline, and how many players are connected. Add \`server:<name>\` to check just one.`,
    `\`/servers\` — Lists the servers this bot manages and how each one is set up.`,
    '',
    '**Admin commands**',
    `\`/command server:<name> name:<command>\` — Runs one of a server's preset commands. Pick the server first and Discord will suggest what that server supports.`,
  ];

  for (const n of names) {
    const server = config.servers[n];
    const entries = Object.values(server.commands);
    if (!entries.length) continue;
    lines.push(
      `  • **${n}**: ${entries.map((c) => `\`${c.name}\`${c.args ? ' (needs `args`)' : ''}`).join(', ')}`,
    );
  }

  const autoOn = names.filter((n) => config.servers[n].autoShutdown.enabled);
  if (autoOn.length) {
    lines.push(
      '',
      '**Automatic shutdown**',
      ...autoOn.map(
        (n) =>
          `\`${n}\` stops itself after ${config.servers[n].autoShutdown.idleMinutes} minutes with no players, to free up the machine. Just \`/start\` it again.`,
      ),
    );
  }

  lines.push('', `_Commands only work in this channel._`);
  // Both messages grow with the number of configured servers and commands, so
  // clamp rather than let them start failing once the config gets big.
  return clamp(lines.join('\n'));
}

/** One server's line for /status, including a player count when reachable. */
async function statusLine(server) {
  const up = await isRunning(server);
  if (!up) return `🔴 **${server.name}** (${server.label}) — Offline.`;

  let players = null;
  try {
    players = await getPlayerCount(server);
  } catch {
    // RCON unreachable (still booting, or RCON disabled) — report the process
    // as up but don't claim a player count we don't have.
  }
  const playerNote = players === null ? 'players: unknown (RCON unreachable)' : `players: ${players}/${server.maxPlayers}`;
  return `🟢 **${server.name}** (${server.label}) — Online: "${server.sessionName}"\n   ${describeServer(server).join(', ')}, ${playerNote}`;
}

// ---- Idle auto-shutdown ----------------------------------------------------
// Poll each server; if one sits at 0 players for its idleMinutes, stop it to
// free up the machine. Shares that server's `busy` lock so it never collides
// with a manual /start or /stop, and treats an unreachable RCON as "unknown"
// (never idle) so a booting server is never killed out from under itself.
// State is per server, so one server going empty never resets another's clock.
const emptySince = new Map(); // server name -> ms timestamp first seen empty
const ticking = new Map(); // re-entrancy guard: a tick can outlast the interval

async function announce(content) {
  try {
    const channel = await client.channels.fetch(config.discord.allowedChannelId);
    if (channel?.isTextBased()) await channel.send(content);
  } catch (err) {
    console.error('Auto-shutdown announce failed:', err.message);
  }
}

async function autoShutdownTick(server) {
  const key = server.name;
  if (ticking.get(key) || isBusy(server)) return; // working, or a manual op holds the lock
  ticking.set(key, true);
  try {
    let up;
    try {
      up = await isRunning(server);
    } catch {
      return;
    }
    if (!up) {
      emptySince.delete(key); // server down — the idle clock is meaningless
      return;
    }

    let count;
    try {
      count = await getPlayerCount(server);
    } catch {
      // RCON unreachable (still booting, or a transient hiccup). Treat as
      // UNKNOWN, not empty — don't advance the idle clock, don't shut down.
      return;
    }

    if (count > 0) {
      emptySince.delete(key);
      return;
    }

    // Empty right now.
    if (!emptySince.has(key)) {
      emptySince.set(key, Date.now());
      console.log(`[${key}] Server empty — idle clock started.`);
      return;
    }
    if (Date.now() - emptySince.get(key) < server.autoShutdown.idleMinutes * 60 * 1000) return;

    // Empty long enough — take the lock and stop it.
    setBusy(server, true);
    try {
      await announce(
        `💤 **${key}** has had no players for ${server.autoShutdown.idleMinutes} minutes — shutting it down to save resources.`,
      );
      await stopServer(server);
      await announce(`🔴 **${key} stopped** automatically (idle).`);
      emptySince.delete(key);
    } catch (err) {
      console.error(`[${key}] Auto-shutdown stop failed:`, err.message);
      await announce(`❌ Auto-shutdown tried to stop **${key}** but failed: ${err.message}`);
    } finally {
      setBusy(server, false);
    }
  } finally {
    ticking.set(key, false);
  }
}

client.login(config.discord.token);
