# Server Sneeker

A Discord bot that lets users in one designated channel **start**, **stop**, and check the **status** of multiple game servers on the same machine — an [Ark: Survival Ascended](https://store.steampowered.com/app/2399830/) server and a [Palworld](https://store.steampowered.com/app/1623730/) server can sit side by side. `/start` runs a SteamCMD update before launching; `/stop` shuts the server down gracefully over RCON (saving first) and falls back to a force kill only if RCON is unreachable.

Every server is declared in `config.json`, and each command takes the server's name, so adding a server is a config edit rather than a code change.

## Commands

Every command takes a `server` option whose choices come from the keys under `servers` in `config.json`. Discord shows them as a dropdown, so you pick `ark` or `palworld` rather than typing it.

| Command | What it does |
|---------|--------------|
| `/start server:<name>` | Updates that server's files via SteamCMD, syncs its settings, then launches it. |
| `/stop server:<name>` | Saves and shuts down over RCON, then confirms the process has exited. |
| `/status [server:<name>]` | Reports whether a server is running, with a live player count. Omit `server` to list every configured server at once. |
| `/command server:<name> name:<cmd> [args:<text>]` | Runs one of that server's whitelisted admin commands (see [Custom commands](#custom-commands)). |
| `/servers` | Lists every configured server and how it's set up — map, player cap, port, mods, commands, idle shutdown. Config only, so it answers instantly. |
| `/help` | Explains `/start`, `/stop` and `/status`, and lists the servers and commands actually configured. |

All commands work **only** in the channel whose ID you set as `ALLOWED_CHANNEL_ID`.

`/servers` and `/help` both reply **privately** (only you see them), so looking things up doesn't clutter the control channel. Both are generated from `config.json` at runtime — add a server or a custom command and it shows up in them automatically, so they can't drift out of date. Point new users at `/help` rather than this README.

`/servers` and `/status` are deliberately different: `/servers` describes what *exists* and never touches the machine, while `/status` reports what's *running right now* by scanning the process list and querying RCON for player counts.

There is deliberately **no raw-RCON command**. Everything that reaches a server over RCON goes through the per-server `commands` whitelist in `config.json`, so Discord users can only run what the config already allows — never arbitrary admin console input.

### Examples

```
/start server:ark                                  # SteamCMD update, then launch ASA
/start server:palworld                             # same for Palworld
/stop server:palworld                              # Save + Shutdown over RCON

/status                                            # every server at once
/status server:ark                                 # just Ark

/command server:ark name:destroywilddinos          # wipe wild dinos
/command server:ark name:saveworld                 # force a world save
/command server:ark name:broadcast args:Server restarting in 5!
/command server:palworld name:players              # list connected players
/command server:palworld name:info                 # server version + name

/servers                                           # what servers exist, and how they're set up
/help                                              # what the commands do
```

`/servers` reports:

```
**2 server(s) configured:**

**ark** — Ark: Survival Ascended
  "Sneekits Server" · TheIsland_WP · up to 70 players · port 7777
  5 mod(s) · commands: destroywilddinos, saveworld, players, broadcast · auto-stops after 15 min idle

**palworld** — Palworld
  "Sneekits Palworld" · up to 32 players · port 8211
  commands: save, players, info, broadcast · auto-shutdown off
```

`/status` with no server reports every one:

```
🟢 ark (Ark: Survival Ascended) — Online: "Sneekits Server"
   Port: 7777, Map: TheIsland_WP, Mods: Pull It!, Super Spyglass, …, players: 3/70
🔴 palworld (Palworld) — Offline.
```

### Custom commands

`/command` only runs what a server whitelists under `commands` in `config.json`, so nobody in the channel can improvise admin commands. Each entry maps the name you type in Discord to the RCON string to send:

```json
"commands": {
  "destroywilddinos": {
    "rcon": "DestroyWildDinos",
    "description": "Wipe all wild dinos (tamed are unaffected)."
  },
  "broadcast": {
    "rcon": "Broadcast",
    "description": "Send a message to everyone on the server.",
    "args": { "required": true, "description": "The message to broadcast." }
  }
}
```

- The key is what you type: `/command server:ark name:destroywilddinos`.
- `description` shows up in Discord's autocomplete, which is filtered by the server you picked — so choosing `ark` only ever suggests Ark's commands.
- Add an `args` block to let a command take free text, which is appended to the RCON string. `/command server:ark name:broadcast args:hello all` sends `Broadcast hello all`. A command without an `args` block rejects the option.

Adding or changing a command is a `config.json` edit plus a bot restart — no code change.

Because `args` text is appended to the RCON string verbatim, only give an `args` block to commands where free text is harmless (a broadcast message, a player ID). A command with no `args` block refuses the option outright.

## Requirements

- **Windows** host that also runs the game servers (this bot shells out to `tasklist`/`taskkill` and launches the exes locally).
- **[Node.js 18+](https://nodejs.org/)**
- **[SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)** installed (used to update the servers).
- The dedicated servers themselves — or SteamCMD will install one into its `steam.installDir` on first `/start`.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Discord application + bot**
   - Go to <https://discord.com/developers/applications> → **New Application**.
   - **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
   - **General Information** → copy the **Application ID** (this is `CLIENT_ID`).
   - No privileged intents are required.

3. **Invite the bot to your server**
   - **OAuth2 → URL Generator** → scopes: `bot` and `applications.commands` → bot permission `Send Messages`.
   - Open the generated URL and add the bot to your server.

4. **Get your IDs** (Discord → Settings → Advanced → enable **Developer Mode**)
   - Right-click your server → **Copy Server ID** → `GUILD_ID`.
   - Right-click the control channel → **Copy Channel ID** → `ALLOWED_CHANNEL_ID`.

5. **Configure secrets**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `ALLOWED_CHANNEL_ID`, and a strong `RCON_PASSWORD`.

   `RCON_PASSWORD` is the shared fallback used by any server without its own. To give a server its own password, set `RCON_PASSWORD_<NAME>` matching its key in `config.json` — `RCON_PASSWORD_ARK`, `RCON_PASSWORD_PALWORLD` — or point at any variable you like with `rconPasswordEnv`. Passwords never live in `config.json`.

6. **Configure your servers**
   ```bash
   cp config.example.json config.json
   ```
   Each key under `servers` is a name you'll type in Discord (`a-z`, `0-9`, `_`, `-`). Per server:

   | Field | Meaning |
   |-------|---------|
   | `game` | Which adapter to use: `ark` or `palworld`. |
   | `sessionName` | The public server name. |
   | `installDir` | Folder containing the exe. Defaults to `steam.installDir`; Ark needs it set explicitly because its exe lives under `ShooterGame\Binaries\Win64`. |
   | `exeName` | The executable to launch. |
   | `port`, `rconPort`, `maxPlayers` | Network and capacity settings. |
   | `map` | Ark only. |
   | `mods` | Ark only — CurseForge IDs; the `name` is cosmetic, shown in `/status`. |
   | `extraArgs` | Extra command-line flags. |
   | `steam.appId` | Steam app ID: `2430930` for ASA, `2394010` for Palworld. |
   | `steam.installDir` | The `+force_install_dir` target for SteamCMD. |
   | `autoShutdown` | Per-server idle shutdown — see below. |
   | `commands` | The `/command` whitelist. |

   Anything you omit falls back to `defaults` in the same file, and then to the game adapter's own defaults in `src/games/<game>.js`. `defaults.steam.steamCmdPath` is a good place for the one path both servers share.

7. **Run the bot**
   ```bash
   npm start
   ```
   Slash commands are (re)registered on startup, so adding a server to `config.json` adds it to the Discord dropdowns on the next boot. To register them without starting the bot: `npm run register`.

## Idle auto-shutdown

Each server can stop itself once it has been empty for a while, freeing the machine. It is configured **per server**, and each keeps its own independent idle clock, so Ark emptying out never affects Palworld:

```json
"autoShutdown": { "enabled": true, "idleMinutes": 15, "pollSeconds": 60 }
```

Omit the block to inherit `defaults.autoShutdown`; set `"enabled": false` to turn it off for that server (no watcher is armed at all). An unreachable RCON counts as **unknown**, never as empty, so a server that is still booting is never shut down out from under itself. A manual `/start` or `/stop` holds a per-server lock the watcher respects.

## How stop works

Neither game has a plain "stop", so the bot:

1. Connects to RCON.
2. Sends the game's save command, then its exit command — `SaveWorld` + `DoExit` for Ark, `Save` + `Shutdown 1` for Palworld.
3. Waits up to `timeouts.shutdownWaitMs` for the process to exit.
4. If RCON was unreachable or the process is still up, force-stops it with `taskkill /F` as a last resort.

## Adding another game

Everything game-specific lives in one file under `src/games/`; `serverManager.js` is game-agnostic and shouldn't need editing. A new adapter provides:

- `defaults` — exe name, ports, player cap, `extraArgs`, and `processNames` if the running process is named differently from the exe you launch.
- `buildLaunchArgs(server)` — the command line.
- `applySettings(server)` — patch any on-disk config file before launch; return a list of what changed (Ark returns `[]`, since it has no settings file).
- `rcon` — the `save` and `exit` commands, plus `playerCount.command` and a `parse` function for its reply. Set `dialect: 'palworld'` if the server doesn't echo RCON packet ids (see below).
- `describe(server)` — extra `/status` detail lines.

Then register it in `src/games/index.js` and reference it with `"game": "<id>"` in `config.json`.

## Game-specific gotchas

These are handled in the code, but worth knowing if you're debugging:

- **Palworld's exe is a launcher shim.** You launch `PalServer.exe`, but the process that stays alive is `PalServer-Win64-Shipping-Cmd.exe` (or the non-`-Cmd` variant, depending on how it was started). Detection matches any name in `processNames`, and the startup grace period is longer to let the handoff finish.
- **`tasklist` truncates long image names.** Its default table output cuts the name at 25 characters, so `PalServer-Win64-Shipping-Cmd.exe` prints as `PalServer-Win64-Shipping-` and never matches. The bot uses `/FO CSV`, which prints the full name.
- **Palworld has no launch-arg config.** RCON, the admin password, port, player cap and server name all live in `Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`, read only at startup. The adapter patches that file before every launch to match `config.json`, keeping a one-time backup as `PalWorldSettings.ini.sneeker-backup`. RCON will not come up until a restart after RCON is first enabled.
- **Palworld doesn't echo RCON packet ids.** It replies with id `0` instead of mirroring the request id, so `rcon-client` — which matches replies to requests by that id — waits forever even though the server ran the command. Palworld therefore uses the small id-tolerant client in `src/rconLite.js`, which correlates replies by arrival order. Ark stays on `rcon-client`.
- **Palworld's `Broadcast` drops anything after the first space.** A server-side limitation, not a bot one.
- **Neither game closes its RCON socket cleanly.** A graceful `end()` would hang waiting for a close event that never arrives, so the bot drops the socket once it has the reply.

## Running it in the background

`npm start` runs in the foreground. Use the bundled scripts to detach it:

```bash
./start-bot.sh     # launches detached, logs to bot.log, writes a PID lockfile
./stop-bot.sh      # stops it
tail -f bot.log    # watch it
```

> Note: this survives closing the terminal but **not a reboot**, and it won't auto-restart if the bot crashes. For always-on operation across reboots, run it as a Windows service (e.g. via [NSSM](https://nssm.cc/)) or a process manager like [PM2](https://pm2.keymetrics.io/).

## Notes

- `.env` and `config.json` are gitignored — only the `.example` files are committed. Never commit your real token.
- Servers are launched **detached**, so they keep running if the bot restarts. `/status` and `/stop` detect them by scanning the process list, so they work even after a bot restart.
- Start/stop locks are **per server**, so starting Ark never blocks starting Palworld. There is no guard against running both at once — mind the machine's RAM.
