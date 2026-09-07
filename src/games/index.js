// Game adapter registry.
//
// Each adapter owns only what is genuinely game-specific: how to build launch
// arguments, whether a settings file needs patching first, the RCON dialect
// for save/exit, and how to count players from its RCON reply. Everything else
// (SteamCMD updates, process detection, the shutdown wait, taskkill fallback)
// lives in serverManager.js and is shared.
//
// To add a game: drop a module here with the same shape and register it below.

import ark from './ark.js';
import palworld from './palworld.js';

export const games = { ark, palworld };

export function getGame(id) {
  const game = games[id];
  if (!game) {
    throw new Error(`Unknown game "${id}". Known games: ${Object.keys(games).join(', ')}.`);
  }
  return game;
}
