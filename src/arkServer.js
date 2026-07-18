import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Rcon } from 'rcon-client';
import { config } from './config.js';

const { server, steam, rcon, timeouts } = config;

const exePath = join(server.installDir, server.exeName);

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

/** True if an ArkAscendedServer.exe process is currently running. */
export async function isRunning() {
  const { stdout } = await run('tasklist', [
    '/FI',
    `IMAGENAME eq ${server.exeName}`,
    '/NH',
  ]);
  return stdout.toLowerCase().includes(server.exeName.toLowerCase());
}

/** Run SteamCMD to install/update the server files. */
export async function updateServer() {
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
  const { code, stdout, stderr } = await run(steam.steamCmdPath, args, {
    timeout: timeouts.updateMs,
  });
  if (code !== 0) {
    throw new Error(`SteamCMD exited with code ${code}. ${stderr || stdout}`.slice(0, 500));
  }
  // SteamCMD is chatty; surface the summary line if present.
  const success = /Success! App '\d+'/.exec(stdout);
  return success ? success[0] : 'Update completed.';
}

/** Launch the ASA server, detached so it survives bot restarts. */
export async function startServer() {
  if (await isRunning()) {
    throw new Error('Server is already running.');
  }
  if (!existsSync(exePath)) {
    throw new Error(`Server exe not found at ${exePath}. Check config.json > server.installDir/exeName.`);
  }

  // Query-string style options come first as a single "?" joined arg.
  const queryOpts = [
    server.map,
    'listen',
    `SessionName=${server.sessionName}`,
    `Port=${server.port}`,
    'RCONEnabled=True',
    `RCONPort=${rcon.port}`,
    `ServerAdminPassword=${rcon.password}`,
  ].join('?');

  const args = [queryOpts, `-WinLiveMaxPlayers=${server.maxPlayers}`, ...(server.extraArgs ?? [])];

  const child = spawn(exePath, args, {
    cwd: server.installDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  // Give it a moment; if it exited immediately, something is wrong.
  await sleep(timeouts.startupGraceMs);
  if (!(await isRunning())) {
    throw new Error('Server process exited immediately after launch. Check the server logs and launch args.');
  }
  return { pid: child.pid };
}

/**
 * Stop the server gracefully via RCON (SaveWorld -> DoExit),
 * falling back to taskkill if RCON is unreachable.
 */
export async function stopServer() {
  if (!(await isRunning())) {
    throw new Error('Server is not running.');
  }

  let method = 'rcon';
  try {
    const conn = await Rcon.connect({
      host: rcon.host,
      port: rcon.port,
      password: rcon.password,
      timeout: 5000,
    });
    try {
      await conn.send('SaveWorld');
      await conn.send('DoExit');
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (err) {
    method = 'taskkill';
  }

  // Wait for the process to actually disappear.
  const deadline = Date.now() + timeouts.shutdownWaitMs;
  while (Date.now() < deadline) {
    if (!(await isRunning())) return { method };
    await sleep(1000);
  }

  // Still up — force kill as a last resort.
  await run('taskkill', ['/IM', server.exeName, '/F', '/T']);
  await sleep(2000);
  if (await isRunning()) {
    throw new Error('Failed to stop the server even after taskkill /F.');
  }
  return { method: 'taskkill-forced' };
}

/**
 * Send a single admin command over RCON and return the server's text reply.
 * Throws if the server isn't running or RCON is unreachable.
 */
export async function sendRconCommand(command) {
  if (!(await isRunning())) {
    throw new Error('Server is not running.');
  }
  const conn = await Rcon.connect({
    host: rcon.host,
    port: rcon.port,
    password: rcon.password,
    timeout: 5000,
  });
  try {
    return await conn.send(command);
  } finally {
    await conn.end().catch(() => {});
  }
}

export const serverInfo = {
  map: server.map,
  sessionName: server.sessionName,
  port: server.port,
  maxPlayers: server.maxPlayers,
};
