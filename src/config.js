import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getGame } from './games/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '' || v.startsWith('your-') || v === 'change-me-to-a-strong-password') {
    throw new Error(`Missing or placeholder env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

const configPath = join(root, 'config.json');
if (!existsSync(configPath)) {
  throw new Error('config.json not found. Copy config.example.json to config.json and edit it for your machine.');
}

let fileConfig;
try {
  fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to parse config.json: ${err.message}`);
}

if (!fileConfig.servers || typeof fileConfig.servers !== 'object' || !Object.keys(fileConfig.servers).length) {
  throw new Error(
    'config.json must define a non-empty "servers" object, keyed by the name used in /start, /stop, etc. See config.example.json.',
  );
}

const defaults = fileConfig.defaults ?? {};

/**
 * A server's RCON password comes from the environment, never config.json.
 * The env var name is either given explicitly (rconPasswordEnv) or derived
 * from the server key: RCON_PASSWORD_ARK, RCON_PASSWORD_PALWORLD, ...
 * A bare RCON_PASSWORD is accepted as a fallback so single-server setups
 * (and the pre-multi-server .env) keep working.
 */
function resolveRconPassword(name, serverConfig) {
  const explicit = serverConfig.rconPasswordEnv;
  const derived = `RCON_PASSWORD_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const candidates = explicit ? [explicit] : [derived, 'RCON_PASSWORD'];
  for (const key of candidates) {
    const v = process.env[key];
    if (v && v.trim() !== '' && v !== 'change-me-to-a-strong-password') return v.trim();
  }
  throw new Error(`No RCON password for server "${name}". Set ${candidates.join(' or ')} in .env.`);
}

/**
 * Normalize the per-server /command whitelist. Each entry maps a short name
 * (what shows up in Discord) to the RCON string to send, plus optional free
 * text appended to it.
 */
function normalizeCommands(serverName, raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      throw new Error(
        `servers.${serverName}.commands."${key}" is not a valid command name (use 1-32 chars: a-z, 0-9, _, -).`,
      );
    }
    const entry = typeof value === 'string' ? { rcon: value } : value ?? {};
    if (!entry.rcon) throw new Error(`servers.${serverName}.commands.${name} is missing an "rcon" string.`);
    out[name] = {
      name,
      rcon: entry.rcon,
      description: entry.description ?? entry.rcon,
      args: entry.args
        ? {
            required: entry.args.required ?? false,
            description: entry.args.description ?? 'Extra text appended to the command.',
          }
        : null,
    };
  }
  return out;
}

/** Merge a server's config with its game defaults and the global defaults. */
function buildServer(name, raw) {
  if (!raw.game) throw new Error(`servers.${name} is missing a "game" field (e.g. "ark", "palworld").`);
  const game = getGame(raw.game);
  const gd = game.defaults ?? {};

  const steam = { ...(defaults.steam ?? {}), ...(raw.steam ?? {}) };
  if (!steam.steamCmdPath) {
    throw new Error(`servers.${name}.steam.steamCmdPath is required (or set defaults.steam.steamCmdPath).`);
  }
  if (!steam.appId) throw new Error(`servers.${name}.steam.appId is required.`);
  if (!steam.installDir) throw new Error(`servers.${name}.steam.installDir is required.`);

  const exeName = raw.exeName ?? gd.exeName;
  if (!exeName) throw new Error(`servers.${name}.exeName is required.`);

  return {
    name,
    game,
    label: raw.label ?? game.label,
    sessionName: raw.sessionName ?? name,
    // Where the exe lives. Defaults to the Steam install root, which is right
    // for Palworld; Ark buries its exe deeper, so it sets this explicitly.
    installDir: raw.installDir ?? steam.installDir,
    exeName,
    // What to look for in tasklist. Palworld's launcher shim exits and hands
    // off to a differently-named process, so this is a list, not one name.
    processNames: raw.processNames ?? gd.processNames ?? [exeName],
    map: raw.map ?? gd.map,
    maxPlayers: raw.maxPlayers ?? gd.maxPlayers,
    port: raw.port ?? gd.port,
    // Steam query port (server browser). Games tend to default this to 27015,
    // so two servers on one box will collide unless it's set apart.
    queryPort: raw.queryPort ?? gd.queryPort,
    rconPort: raw.rconPort ?? gd.rconPort,
    mods: raw.mods ?? [],
    extraArgs: raw.extraArgs ?? gd.extraArgs ?? [],
    settingsFile: raw.settingsFile,
    steam,
    rcon: {
      host: raw.rcon?.host ?? defaults.rcon?.host ?? '127.0.0.1',
      port: raw.rconPort ?? gd.rconPort,
      password: resolveRconPassword(name, raw),
    },
    timeouts: {
      updateMs: raw.timeouts?.updateMs ?? defaults.timeouts?.updateMs ?? 30 * 60 * 1000,
      startupGraceMs:
        raw.timeouts?.startupGraceMs ?? defaults.timeouts?.startupGraceMs ?? gd.startupGraceMs ?? 5000,
      shutdownWaitMs: raw.timeouts?.shutdownWaitMs ?? defaults.timeouts?.shutdownWaitMs ?? 20000,
    },
    autoShutdown: {
      enabled: raw.autoShutdown?.enabled ?? defaults.autoShutdown?.enabled ?? true,
      idleMinutes: raw.autoShutdown?.idleMinutes ?? defaults.autoShutdown?.idleMinutes ?? 30,
      pollSeconds: raw.autoShutdown?.pollSeconds ?? defaults.autoShutdown?.pollSeconds ?? 60,
    },
    commands: normalizeCommands(name, raw.commands ?? {}),
  };
}

const servers = {};
for (const [name, raw] of Object.entries(fileConfig.servers)) {
  const key = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(key)) {
    throw new Error(
      `Server name "${name}" is invalid (use 1-32 chars: a-z, 0-9, _, -). It becomes a Discord choice value.`,
    );
  }
  servers[key] = buildServer(key, raw);
}

/**
 * Fail fast on port collisions between servers.
 *
 * This is worth checking at boot because the symptom is otherwise invisible
 * and misleading: the game that starts second launches "successfully", but
 * silently fails to bind the port it lost and never appears in the server
 * browser. Games commonly share defaults — both Ark and Palworld default the
 * Steam query port to 27015 — so a two-server setup collides out of the box.
 */
function assertNoPortCollisions(all) {
  const seen = new Map(); // port number -> "server.role" that claimed it first
  for (const server of Object.values(all)) {
    for (const [role, port] of [
      ['game port', server.port],
      ['query port', server.queryPort],
      ['RCON port', server.rconPort],
    ]) {
      if (port === undefined || port === null) continue;
      const owner = `${server.name} ${role}`;
      const existing = seen.get(port);
      if (existing) {
        throw new Error(
          `Port ${port} is claimed by both ${existing} and ${owner}. Every game, query and RCON port must be unique across all servers in config.json.`,
        );
      }
      seen.set(port, owner);
    }
  }
}

assertNoPortCollisions(servers);

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('CLIENT_ID'),
    guildId: requireEnv('GUILD_ID'),
    allowedChannelId: requireEnv('ALLOWED_CHANNEL_ID'),
  },
  servers,
  serverNames: Object.keys(servers),
};

export function getServer(name) {
  const server = config.servers[String(name ?? '').trim().toLowerCase()];
  if (!server) {
    throw new Error(`Unknown server "${name}". Configured servers: ${config.serverNames.join(', ')}.`);
  }
  return server;
}
