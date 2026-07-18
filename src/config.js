import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('CLIENT_ID'),
    guildId: requireEnv('GUILD_ID'),
    allowedChannelId: requireEnv('ALLOWED_CHANNEL_ID'),
  },
  server: fileConfig.server,
  steam: fileConfig.steam,
  rcon: {
    host: fileConfig.rcon?.host ?? '127.0.0.1',
    port: fileConfig.server.rconPort,
    password: requireEnv('RCON_PASSWORD'),
  },
  timeouts: {
    updateMs: fileConfig.timeouts?.updateMs ?? 30 * 60 * 1000,
    startupGraceMs: fileConfig.timeouts?.startupGraceMs ?? 5000,
    shutdownWaitMs: fileConfig.timeouts?.shutdownWaitMs ?? 20000,
  },
};
