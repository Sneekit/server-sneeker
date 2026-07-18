# Server Sneeker

A Discord bot that lets users in one designated channel **start**, **stop**, and check the **status** of an [Ark: Survival Ascended](https://store.steampowered.com/app/2399830/) dedicated server. `/start` runs a SteamCMD update before launching; `/stop` shuts the server down gracefully over RCON (saving the world first) and falls back to a force kill only if RCON is unreachable.

## Commands

| Command   | What it does                                                                 |
|-----------|------------------------------------------------------------------------------|
| `/start`  | Updates the server files via SteamCMD, then launches `ArkAscendedServer.exe`. |
| `/stop`   | `SaveWorld` + `DoExit` over RCON, then confirms the process has exited.        |
| `/status` | Reports whether the server process is currently running.                       |
| `/destroywilddinos` | Wipes all wild dinos over RCON (tamed dinos are unaffected); forces fresh spawns. |

All commands work **only** in the channel whose ID you set as `ALLOWED_CHANNEL_ID`.

## Requirements

- **Windows** host that also runs the ASA server (this bot shells out to `tasklist`/`taskkill` and launches the exe locally).
- **[Node.js 18+](https://nodejs.org/)** — *not currently installed on this machine.* Install the LTS build, then reopen your terminal so `node` and `npm` are on PATH.
- **[SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)** installed (used to update the server).
- An **ASA dedicated server** already installed (or SteamCMD will install it into `steam.installDir` on first `/start`).

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
   Edit `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `ALLOWED_CHANNEL_ID`, and a strong `RCON_PASSWORD`.

6. **Configure the server paths**
   ```bash
   cp config.example.json config.json
   ```
   Edit `config.json`:
   - `server.installDir` — folder containing `ArkAscendedServer.exe` (usually `...\ShooterGame\Binaries\Win64`).
   - `server.map`, `sessionName`, `maxPlayers`, `port`, `rconPort` — your launch settings.
   - `steam.steamCmdPath` — full path to `steamcmd.exe`.
   - `steam.installDir` — where the server is/should be installed (the `+force_install_dir` target).

7. **Run the bot**
   ```bash
   npm start
   ```
   Slash commands are (re)registered automatically on startup. To register them manually without starting the bot: `npm run register`.

## How stop works

Ark: Survival Ascended has no built-in "stop" command, so the bot:

1. Connects to RCON (enabled automatically at launch via `RCONEnabled=True` and your `RCON_PASSWORD`).
2. Sends `SaveWorld`, then `DoExit` for a clean shutdown.
3. Waits up to `timeouts.shutdownWaitMs` for the process to exit.
4. If RCON was unreachable or the process is still up, force-stops it with `taskkill /F` as a last resort.

## Running it in the background

`npm start` runs in the foreground. To detach it (git bash) so it keeps running after you close the terminal:

```bash
nohup node src/index.js > bot.log 2>&1 &
disown
echo $!        # prints the bot's real PID; note it down
```

- `nohup` — survives closing the terminal.
- `> bot.log 2>&1` — sends all output to `bot.log`.
- `disown` — drops it from the shell's job list so the shell won't kill it on exit.

Check on it with `tail -f bot.log`; stop it with `kill <PID>`.

If you forget the PID, find and kill it by its command line:

```bash
kill $(pgrep -f 'src/index.js')
```

> Note: this survives closing the terminal but **not a reboot**, and it won't auto-restart if the bot crashes. For always-on operation across reboots, run it as a Windows service (e.g. via [NSSM](https://nssm.cc/)) or a process manager like [PM2](https://pm2.keymetrics.io/).

## Notes

- `.env` and `config.json` are gitignored — only the `.example` files are committed. Never commit your real token.
- The server is launched **detached**, so it keeps running if the bot restarts. `/status` and `/stop` detect it by scanning the process list, so they work even after a bot restart.
