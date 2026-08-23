# SandustryMP compatibility notes

Compatibility target: Sandustry game build 0.5.5. Both players must run the same SandustryMP and protocol versions.

## Primary files

- `src/sandustrymp.js` contains the renderer-side multiplayer implementation.
- `src/network.js` contains renderer networking support.
- `src/state.js` contains synchronized player and game state support.
- `src/menu.js` contains main-menu integration.
- `src/localisation.js` contains localized UI strings.
- `src/patches.json` defines the supported bundle hooks.
- `dist-package/src` and `workshop/content/src` contain synchronized release copies.

## Current architecture

- The host runs the authoritative simulation and validates client actions through the game's native routines.
- Clients send action intent and render the results returned by the host.
- World state, structures, resources, research, tiers, players, drones, and world items are reconciled from host snapshots and event messages.
- Save transfer uses temporary multiplayer snapshots rather than selecting the client's most recent local save.

## Release verification

- Run JavaScript syntax checks for changed source files.
- Parse all copies of `patches.json`.
- Confirm source and packaged copies have matching hashes.
- Run `git diff --check` before committing.
