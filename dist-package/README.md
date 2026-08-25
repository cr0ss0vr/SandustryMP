# SandustryMP

SandustryMP is an experimental co-op multiplayer mod for Sandustry.

**Author:** Cr0ss0vr

**Version:** v0.2.10

The host owns the authoritative world. Clients receive that world and send gameplay requests to the host, which validates and executes them through Sandustry's original game logic.

> SandustryMP modifies the game's Electron application. A Sandustry update may require the mod to be reinstalled or updated.

## Installation

Both players must install the same SandustryMP version.

### Windows

1. Install and launch Sandustry once.
2. Run `install.bat` from this folder.
3. Start Sandustry normally.

If required, run `install.ps1` from PowerShell instead.

### macOS

1. Install and launch Sandustry once.
2. Run `install.command`.
3. Start the game with `SandustryMP-Launch.command` if a game update has restored the original application archive.

### Linux

1. Install and launch Sandustry once.
2. Run `bash install-linux.sh` in a terminal.
3. Start Sandustry normally.

You may pass a non-standard Sandustry installation directory to the macOS or Linux installer.

## Playing

Select **Multiplayer** from Sandustry's main menu.

### Steam

1. The host starts a Steam session.
2. The host invites the other player.
3. The host loads or creates the world.
4. The joining player waits for the host's temporary world snapshot to import and load.

### LAN

1. The host selects **Host LAN**.
2. The client selects **Join LAN** and enters the host address.
3. The host loads or creates the world.

The default LAN port is `27777`.

## How synchronization works

- The host runs the authoritative simulation.
- Client actions are requests; the host validates them with native Sandustry rules before changing the world.
- The client simulation is paused while the host streams compressed world changes.
- Structures, resources, research, factory tiers, players, drones, artefacts, and progression are reconciled from the host.
- Joining uses a newly created temporary host save, preventing the client from loading an unrelated local save.

Use **Resync** if the client needs a complete world refresh. The multiplayer panel also shows connection status, player names, transfer progress, ping, and version mismatches.

## Logs

When Sandustry is launched with:

```text
--smp-userdata=C:\temp\SandustryMP\client1
```

logs are written to that directory's `logs` folder. Without the argument, logs use Sandustry's default application-data location.

When reporting a multiplayer problem, include logs from both the host and the client.

## Reinstalling or uninstalling

After a Sandustry update, rerun the installer so the current game files receive the required patches.

To remove the mod, verify Sandustry's installed files through Steam and remove the extracted `resources/app` directory if it remains.

## License

MIT © Cr0ss0vr
