// Ark: Survival Ascended adapter.
//
// ASA takes its entire configuration on the command line: the map, session
// name, ports and RCON credentials all ride in a single "?"-joined query
// string, so there is no settings file to patch before launch.

/**
 * Normalize the configured mods into { id, name } entries. Each config entry
 * may be a bare CurseForge ID ("940022") or an object ({ id, name }). Blank or
 * id-less entries are dropped; a missing name falls back to the id.
 */
export function normalizeMods(server) {
  return (server.mods ?? [])
    .map((m) => (typeof m === 'object' && m !== null ? m : { id: m }))
    .map(({ id, name }) => ({ id: String(id ?? '').trim(), name: (name ?? '').trim() }))
    .filter((m) => m.id)
    .map((m) => ({ id: m.id, name: m.name || m.id }));
}

export default {
  id: 'ark',
  label: 'Ark: Survival Ascended',

  // ASA's exe is also the process that keeps running, so process detection
  // needs no special-casing here.
  defaults: {
    exeName: 'ArkAscendedServer.exe',
    port: 7777,
    rconPort: 27020,
    maxPlayers: 20,
    extraArgs: ['-server', '-log', '-NoBattlEye'],
  },

  /** Nothing to write to disk — see the note at the top of the file. */
  applySettings() {
    return [];
  },

  buildLaunchArgs(server) {
    // Query-string style options come first as a single "?" joined arg.
    const queryOpts = [
      server.map,
      'listen',
      `SessionName=${server.sessionName}`,
      `Port=${server.port}`,
      'RCONEnabled=True',
      `RCONPort=${server.rconPort}`,
      `ServerAdminPassword=${server.rcon.password}`,
    ].join('?');

    // Mods load via the -mods= switch: a comma-separated list of CurseForge IDs.
    const mods = normalizeMods(server);
    const modArg = mods.length ? [`-mods=${mods.map((m) => m.id).join(',')}`] : [];

    return [
      queryOpts,
      `-WinLiveMaxPlayers=${server.maxPlayers}`,
      ...modArg,
      ...(server.extraArgs ?? []),
    ];
  },

  rcon: {
    save: 'SaveWorld',
    // DoExit tears the server down before it can reply; the caller tolerates
    // the resulting rejected send.
    exit: ['DoExit'],
    playerCount: {
      command: 'ListPlayers',
      /**
       * ASA returns "No Players Connected" (wording varies) when empty;
       * otherwise each connected player is one numbered line: "0. Name, <id>".
       */
      parse(text) {
        if (!text || /no players/i.test(text)) return 0;
        return text.split('\n').filter((l) => /^\s*\d+\.\s/.test(l)).length;
      },
    },
  },

  /** Extra detail for /status, beyond the shared name/port/player lines. */
  describe(server) {
    const mods = normalizeMods(server);
    return [
      `Map: ${server.map}`,
      mods.length ? `Mods: ${mods.map((m) => m.name).join(', ')}` : null,
    ].filter(Boolean);
  },
};
