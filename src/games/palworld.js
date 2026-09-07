// Palworld adapter.
//
// Palworld is the mirror image of Ark: almost nothing meaningful can be passed
// on the command line. The server name, player cap, port and — critically —
// the RCON switch and admin password all live in
//   Pal/Saved/Config/WindowsServer/PalWorldSettings.ini
// as one giant single-line OptionSettings=(...) blob. The server only reads it
// at startup, so applySettings() patches that blob before every launch to keep
// the ini in sync with config.json.
//
// Two more Palworld quirks the shared code leans on:
//   - PalServer.exe is a launcher shim; the process that actually stays alive
//     is PalServer-Win64-Shipping-Cmd.exe (or the non-Cmd variant, depending
//     on how it was started). Detection has to match either, which is why
//     processNames is a list rather than just exeName.
//   - The shim exits once the child is up, so the startup grace period needs
//     to be longer than Ark's.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/** Default location of the live settings file, relative to the install root. */
const SETTINGS_REL = join('Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');

function settingsPath(server) {
  return server.settingsFile ?? join(server.steam.installDir, SETTINGS_REL);
}

/**
 * Set one key inside the single-line OptionSettings=(...) blob.
 * Values are pre-formatted by the caller (quoted for strings, bare for
 * numbers and True/False). Appends the key if it isn't already present.
 */
function setOption(blob, key, formattedValue) {
  // A value is either a quoted string (which may itself contain commas) or a
  // bare run of characters up to the next comma or the closing paren.
  const re = new RegExp(`(?<=[(,])${key}=(?:"[^"]*"|[^,)]*)`);
  if (re.test(blob)) return blob.replace(re, `${key}=${formattedValue}`);
  // Not present — insert just before the final closing paren.
  return blob.replace(/\)\s*$/, `,${key}=${formattedValue})`);
}

const quote = (v) => `"${String(v)}"`;

export default {
  id: 'palworld',
  label: 'Palworld',

  defaults: {
    // What we launch...
    exeName: 'PalServer.exe',
    // ...versus what actually keeps running. Either variant may be the live
    // process depending on how the server was started (Steam picks -Cmd).
    processNames: ['PalServer-Win64-Shipping-Cmd.exe', 'PalServer-Win64-Shipping.exe'],
    port: 8211,
    queryPort: 27015,
    rconPort: 25575,
    maxPlayers: 32,
    // Palworld's documented performance flags for dedicated servers.
    extraArgs: ['-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'],
    // The shim has to hand off to the shipping exe before we can see it.
    startupGraceMs: 20000,
  },

  /**
   * Patch PalWorldSettings.ini so the running server matches config.json and
   * has RCON reachable with our password. Returns a list of human-readable
   * notes about what changed, for the Discord reply.
   */
  applySettings(server) {
    const file = settingsPath(server);
    if (!existsSync(file)) {
      throw new Error(
        `Palworld settings file not found at ${file}. Start the server once from Steam, or set servers.${server.name}.settingsFile in config.json.`,
      );
    }
    if (String(server.rcon.password).includes('"')) {
      throw new Error('Palworld RCON password cannot contain a double quote — it breaks the ini format.');
    }

    const original = readFileSync(file, 'utf8');
    const match = /^(\s*OptionSettings=)(\(.*\))\s*$/m.exec(original);
    if (!match) {
      throw new Error(`Could not find the OptionSettings=(...) line in ${file}.`);
    }

    const wanted = {
      RCONEnabled: 'True',
      RCONPort: String(server.rconPort),
      AdminPassword: quote(server.rcon.password),
      PublicPort: String(server.port),
      ServerPlayerMaxNum: String(server.maxPlayers),
      ServerName: quote(server.sessionName),
    };

    let blob = match[2];
    const changed = [];
    for (const [key, value] of Object.entries(wanted)) {
      const before = blob;
      blob = setOption(blob, key, value);
      if (blob !== before) changed.push(key === 'AdminPassword' ? 'AdminPassword (hidden)' : `${key}=${value}`);
    }
    if (!changed.length) return [];

    // Keep a one-time backup of whatever was there before we first touched it.
    const backup = `${file}.sneeker-backup`;
    if (!existsSync(backup)) copyFileSync(file, backup);

    writeFileSync(file, original.replace(match[0], `${match[1]}${blob}`), 'utf8');
    return changed;
  },

  buildLaunchArgs(server) {
    // Port and player cap are also accepted on the CLI and win over the ini,
    // so pass them for good measure; RCON is ini-only.
    return [
      `-port=${server.port}`,
      // Steam query port. Palworld defaults it to 27015, exactly like Ark, so
      // running both on one box needs them set apart explicitly or the second
      // server to start can't bind it and stays out of the server browser.
      `-queryport=${server.queryPort}`,
      `-players=${server.maxPlayers}`,
      ...(server.extraArgs ?? []),
    ];
  },

  rcon: {
    // Palworld answers commands with packet id 0 instead of mirroring the id
    // it was sent, which makes rcon-client wait forever for a matching reply.
    // See src/rconLite.js for the id-tolerant transport this selects.
    dialect: 'palworld',
    save: 'Save',
    // "Shutdown <seconds>" is Palworld's graceful exit; it drops the socket
    // as it goes down, same as Ark's DoExit.
    exit: ['Shutdown 1'],
    playerCount: {
      command: 'ShowPlayers',
      /**
       * Palworld answers with CSV and a header row:
       *   name,playeruid,steamid
       *   Foo,12345,7656119...
       * An empty server returns the header alone.
       */
      parse(text) {
        if (!text) return 0;
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !/^name,\s*playeruid/i.test(l));
        return lines.length;
      },
    },
  },

  describe() {
    // Palworld has no mods or map to report beyond the shared port line.
    return { facts: [], lines: [] };
  },
};
