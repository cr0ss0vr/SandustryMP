# SandustryMP

SandustryMP is an experimental co-op multiplayer mod for Sandustry.

**Author:** Cr0ss0vr

**Current version:** v0.3.8

The host owns the authoritative game state. Other players connect through Steam or a Direct connection, receive the host's world, and send gameplay requests back to the host for validation and execution.

> Sandustry does not currently provide an official mod API for this project. SandustryMP patches the Electron application and may need compatibility updates after a Sandustry release.

## Installation

Download or clone this repository, then use the installer for your platform from `dist-package`:

- Windows: run `install.bat`.
- macOS: run `install.command`.
- Linux: run `bash install-linux.sh`.

The installer locates Sandustry, extracts its Electron application when necessary, copies the SandustryMP modules into the game, applies the required bundle patches, and installs the simulation-worker bootstrap.

Both the host and every client must use the same SandustryMP version and a compatible Sandustry build.

## Starting a game

Open Sandustry and select **Multiplayer** from the main menu.

- **Steam:** host a Steam session and invite another player, or join an existing lobby.
- **Direct:** select **Host Direct**, choose a port, and connect with **Join Direct** using the host's address and port. The default port is `27777`. SandustryMP requests a UPnP mapping for online connections; if the router does not support or permit UPnP, Direct hosting remains available over LAN or VPN.

The host should load or create the world. When a client joins, the host creates a temporary save snapshot and transfers that exact snapshot. The client imports and loads it, then both sides remove the temporary snapshot from their loadable saves.

## Architecture

Sandustry's simulation is not deterministic enough for pure lockstep multiplayer. SandustryMP therefore combines host-authoritative actions with a corrective world mirror.

### Host authority

The host runs the complete simulation and owns the canonical world, structures, resources, research, factory tiers, entities, and progression. Client messages describe intent, not trusted results.

For actions such as building placement, replacement, research, demolition, tools, and weapons, the host checks the request against the original Sandustry logic. Only the result produced by the host is replicated. Placement can therefore return a complete structure, a queued frame, or no placement depending on native clearance and unlock validation.

### Client simulation and world mirror

The client's manager simulation is paused while connected. Rendering and local player movement remain active, but canonical world changes come from the host.

The host sends compressed row deltas for dirty 40 x 40 chunks. Mirrored data includes terrain, walls, fog, authorization, collision cell IDs, and resolved element types. Congestion control keeps pending changes on the host so repeated edits coalesce instead of building an outdated ordered network backlog.

Periodic snapshots and event messages reconcile structures, pipes, resources, research, tiers, players, drones, and native world items such as artefacts. Hash probes compare selected host and client chunks while the mirror remains the authoritative correction path.

### Networking

Networking runs in the Electron main process so it survives renderer scene changes. SandustryMP supports:

- Steam lobbies and peer-to-peer packets.
- A dependency-free Direct WebSocket transport with best-effort UPnP online hosting.
- Version and game-build checks during connection setup.
- Acknowledgements, reconnect handling, ping measurement, and temporary save transfer.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/sandustrymp.js` | Renderer entry point, host action execution, world reconciliation, and game hooks |
| `src/network.js` | Renderer networking subscriptions and connection state |
| `src/state.js` | Shared runtime state and synchronization bookkeeping |
| `src/menu.js` | Main-menu Multiplayer button and lobby interface |
| `src/localisation.js` | Localized user-interface strings |
| `src/smp-main.js` | Electron main-process Steam, Direct, IPC, save-transfer, and logging support |
| `src/upnp.js` | UPnP gateway discovery and Direct TCP port-mapping lifecycle |
| `src/smp-preload-append.js` | Preload bridge exposed to the renderer |
| `src/sim-worker-bootstrap.js` | Simulation-worker deterministic clock bootstrap |
| `src/patches.json` | Version-specific bundle patch anchors |
| `src/patch.js` | Installer patch runner |
| `dist-package` | Standalone release package |

`dist-package/src` contains a direct release copy of `src`. Keep both directories synchronized when preparing a release.

## Development and testing

After changing renderer or main-process code:

1. Synchronize `src` into `dist-package/src`.
2. Run `node --check` on changed JavaScript files.
3. Parse and validate every packaged copy of `patches.json`.
4. Run `git diff --check`.
5. Reinstall the mod whenever bundle patches or Electron main-process files change.

For a local two-instance test, launch the second instance with a separate data directory:

```text
--smp-userdata=C:\temp\SandustryMP\client1
```

Logs are written beneath the specified data directory in its `logs` folder. Without `--smp-userdata`, SandustryMP uses Sandustry's default application-data log location.

## License

[MIT](LICENSE) © Cr0ss0vr
