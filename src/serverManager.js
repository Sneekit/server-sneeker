import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Rcon } from 'rcon-client';
import { connectLite } from './rconLite.js';

// Game-agnostic server lifecycle. Every function takes a resolved server
// object from config.js; anything game-specific is delegated to server.game
// (see src/games/). Adding a game should never require editing this file.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a command to completion, capturing stdout/stderr.
 * Resolves { code, stdout, stderr }; rejects on spawn error or timeout.
 */
function run(command, args, { timeout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer;

    if (timeout) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
      }, timeout);
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** True if any of the server's process names is currently running. */
export async function isRunning(server) {
  for (const name of server.processNames) {
    // /FO CSV is load-bearing: tasklist's default table format truncates the
    // image name to 25 characters, so a long name like
    // "PalServer-Win64-Shipping-Cmd.exe" prints as "PalServer-Win64-Shipping-"
    // and would never match the substring test below.
    const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV']);
    if (stdout.toLowerCase().includes(name.toLowerCase())) return true;
  }
  return false;
}

/** Run SteamCMD to install/update the server files. */
export async function updateServer(server) {
  const { steam, timeouts } = server;
  if (!existsSync(steam.steamCmdPath)) {
    throw new Error(`SteamCMD not found at ${steam.steamCmdPath}. Check config.json > steam.steamCmdPath.`);
  }
  const args = [
    '+force_install_dir',
    steam.installDir,
    '+login',
    'anonymous',
    '+app_update',
    String(steam.appId),
    'validate',
    '+quit',
  ];
  const { code, stdout, stderr } = await run(steam.steamCmdPath, args, { timeout: timeouts.updateMs });
  if (code !== 0) {
    throw new Error(`SteamCMD exited with code ${code}. ${stderr || stdout}`.slice(0, 500));
  }
  // SteamCMD is chatty; surface the summary line if present.
  const success = /Success! App '\d+'/.exec(stdout);
  return success ? success[0] : 'Update completed.';
}

/**
 * Launch the server, detached so it survives bot restarts.
 * Games whose settings live in a file on disk (Palworld) get a chance to
 * patch it first via the adapter's applySettings hook.
 */
export async function startServer(server) {
  if (await isRunning(server)) {
    throw new Error(`${server.label} is already running.`);
  }

  const exePath = join(server.installDir, server.exeName);
  if (!existsSync(exePath)) {
    throw new Error(
      `Server exe not found at ${exePath}. Check config.json > servers.${server.name}.installDir/exeName.`,
    );
  }

  // Any pooled connection belongs to a previous, now-dead instance.
  dropConnection(server);

  // Sync any on-disk settings file before launch (no-op for Ark).
  const settingsChanged = server.game.applySettings(server);

  const args = server.game.buildLaunchArgs(server);
  const child = spawn(exePath, args, {
    cwd: server.installDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  // Give it a moment; if nothing is running by now, something is wrong.
  // Note this checks processNames, not the spawned pid: Palworld's exe is a
  // launcher shim that exits once the real server process is up.
  await sleep(server.timeouts.startupGraceMs);
  if (!(await isRunning(server))) {
    throw new Error(
      'Server process exited immediately after launch. Check the server logs and launch args.',
    );
  }
  return { pid: child.pid, settingsChanged };
}

/**
 * Open an RCON connection, normalized to { send, destroy } whichever
 * transport the game needs.
 *
 * Most games speak well-behaved Source RCON and use rcon-client. Palworld
 * returns packet id 0 instead of mirroring the request id, which makes
 * rcon-client's id-based reply matching hang, so its adapter selects the
 * id-tolerant client in src/rconLite.js instead.
 */
async function connectRcon(server) {
  const { host, port, password } = server.rcon;

  if (server.game.rcon.dialect === 'palworld') {
    // Already exposes { send, destroy }.
    return connectLite({ host, port, password, timeout: 5000 });
  }

  // A socket error (e.g. the server dies mid-command) re-emits as an 'error'
  // event on the connection; an EventEmitter with no 'error' listener THROWS,
  // which would crash the whole bot. The forwarder goes live inside connect()
  // BEFORE the auth handshake returns, so attaching after Rcon.connect()
  // resolves leaves a window where a reset during auth is unhandled.
  // Construct, listen, THEN connect so the listener always exists first.
  const conn = new Rcon({ host, port, password, timeout: 5000 });
  conn.on('error', () => {});
  await conn.connect();
  return {
    send: (command) => conn.send(command),
    destroy() {
      // Neither Ark nor Palworld closes the RCON socket cleanly, so a graceful
      // conn.end() (which waits for the socket's 'close' event) would hang
      // forever. The command has already executed and its response is in hand.
      if (conn.socket && !conn.socket.destroyed) conn.socket.destroy();
    },
  };
}

// One live RCON connection per server, reused across commands.
//
// This is not just an optimization. Palworld never closes its end of an RCON
// socket after the client disconnects — the server side sits in CloseWait
// forever — and it takes only a couple of those leaked slots before it stops
// answering new connections at all, RCON effectively dead until a restart.
// Opening a connection per command (with /status polling every 60s) wedges it
// within minutes. Holding one connection open avoids the churn entirely.
const connections = new Map(); // server name -> { send, destroy }

async function getConnection(server) {
  const existing = connections.get(server.name);
  if (existing) return existing;
  const conn = await connectRcon(server);
  connections.set(server.name, conn);
  return conn;
}

/** Forget and close a server's pooled connection. */
function dropConnection(server) {
  const conn = connections.get(server.name);
  if (!conn) return;
  connections.delete(server.name);
  try {
    conn.destroy();
  } catch {
    // Already gone — nothing to clean up.
  }
}

/**
 * Stop the server gracefully via RCON (save, then the game's exit command),
 * falling back to taskkill if RCON is unreachable.
 */
export async function stopServer(server) {
  if (!(await isRunning(server))) {
    throw new Error(`${server.label} is not running.`);
  }

  const { save, exit } = server.game.rcon;
  let method = 'rcon';
  try {
    const conn = await getConnection(server);
    try {
      if (save) await conn.send(save);
      for (const command of exit) {
        // The exit command tears the server down before it can reply, so this
        // send rejects ("Connection closed"/timeout). Expected, not a failure.
        await conn.send(command).catch(() => {});
      }
    } finally {
      // The server is on its way down; this connection is spent either way.
      dropConnection(server);
    }
  } catch {
    method = 'taskkill';
    dropConnection(server);
  }

  // Wait for the process to actually disappear.
  const deadline = Date.now() + server.timeouts.shutdownWaitMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(server))) return { method };
    await sleep(1000);
  }

  // Still up — force kill as a last resort. Kill the launcher shim too, so a
  // Palworld shim left holding the child goes down with it.
  const killNames = [...new Set([...server.processNames, server.exeName])];
  for (const name of killNames) {
    await run('taskkill', ['/IM', name, '/F', '/T']);
  }
  await sleep(2000);
  if (await isRunning(server)) {
    throw new Error('Failed to stop the server even after taskkill /F.');
  }
  return { method: 'taskkill-forced' };
}

/**
 * Send a single admin command over RCON and return the server's text reply.
 * Throws if the server isn't running or RCON is unreachable.
 */
export async function sendRconCommand(server, command) {
  if (!(await isRunning(server))) {
    throw new Error(`${server.label} is not running.`);
  }
  // Reuse the pooled connection, but a pooled socket can have gone stale
  // (server restarted outside the bot, idle disconnect), so one retry on a
  // fresh connection before giving up.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const conn = await getConnection(server);
      return await conn.send(command);
    } catch (err) {
      lastErr = err;
      dropConnection(server);
    }
  }
  throw lastErr;
}

/**
 * Query the number of connected players via RCON.
 * Returns an integer count (0 when empty). Throws if the server isn't running
 * or RCON is unreachable — callers must treat a throw as "unknown", NOT as
 * zero, so a booting or unreachable server is never mistaken for an idle one.
 */
export async function getPlayerCount(server) {
  const { command, parse } = server.game.rcon.playerCount;
  const reply = await sendRconCommand(server, command);
  return parse((reply ?? '').trim());
}

/**
 * Format an RCON reply for a Discord message: echo the server's actual text
 * in a code block, or a neutral note when the server returned nothing. RCON
 * has no success/failure signal, so we report what the server said rather
 * than asserting an outcome.
 */
export function formatRconReply(reply) {
  const text = (reply ?? '').trim();
  return text
    ? `Server replied:\n\`\`\`\n${text}\n\`\`\``
    : '_The server acknowledged the command but returned no message._';
}

/** Shared /status detail lines, plus whatever the game wants to add. */
export function describeServer(server) {
  return [`Port: ${server.port}`, ...server.game.describe(server)];
}
