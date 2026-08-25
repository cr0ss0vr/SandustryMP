# SandustryMP changelog

All notable changes to SandustryMP are recorded here. Dates use the ISO `YYYY-MM-DD` format.

## v0.3.11 - 2026-08-25

- Resolve client Drill targets through Sandustry's native raycast so damaged Stone remains the active target instead of allowing the drill to pass through to Dirt or Scoria behind it.
- Validate remote Drill use against the shared Drill technology rather than the host inventory or lagging renderer-only equipment packets.
- Keep native excavation and authoritative energy consumption paired on the host for every successful client Drill pulse.
- Match the native Drill's approximately 60 Hz excavation cadence and redraw nearby terrain after each hit so hidden surroundings are revealed as they are for the host.

## v0.3.10 - 2026-08-25

- Verify client-triggered story waypoints against the authoritative host objective and the client's synchronized position.
- Complete the Stage 5 anomaly through Sandustry's native progression routine so the host advances the story and preserves the interactable state across all players.

## v0.3.9 - 2026-08-25

- Preserve Sandustry's native Gold-only shaker filter when the host executes a client's placement request, restoring shaker processing.
- Apply a client's selected material filter only to native player-configurable filter structures.
- Forward post-placement advanced-filter group edits to the host and propagate the complete multi-element selection to simulation workers.
- Preserve Sandustry's native liquid and gas handling flags on client-configured Mk2 advanced filters so selected fluids are actually allowed or blocked.
- Recognize Sandustry's numeric Pipe structure selection in the client deconstruction overlay and route it exclusively through native pipe removal.
- Immediately relay the host-confirmed pipe removals to clients so recently placed pipes do not remain visible until snapshot reconciliation.

## v0.3.8 - 2026-08-25

- Refresh the host's resource HUD immediately after an accepted client upgrade deducts its cost from the shared Fluxite pool.

## v0.3.7 - 2026-08-25

- Drive held client grabber requests from the render frame instead of Sandustry's slower native collection pulse, allowing another verified pickup immediately after each host response.
- Remove the host's silent 30 ms grab-request drop while retaining one bounded client request in flight and all native restricted-zone, capacity, liquid, type-lock, and spatial-slot validation.

## v0.3.6 - 2026-08-25

- Reconcile authoritative Mining, Recon, and Hauler drone records without replacing the objects used by Sandustry's renderer.
- Create and remove remote drone sprites through Sandustry's native sprite routines, retaining each drone type's textures and animation hooks.
- Keep mining-drone tilt state local to the renderer so network pulses do not repeatedly reset its animation.
- Translate drone materialisation and dissolve timestamps onto the receiving game's clock, preventing Recon drones from sticking or growing after recall.
- Smooth client-side drone presentation between authoritative host positions so return flights no longer step, jitter, or repeatedly over-correct their native rotation.
- Tag client-deployed Mining drones with their owner and make the host's native return routine follow that player's current synchronized position instead of returning them to the host.
- Send the client's complete Sweeper target reservation plan to the host before spawning its drones, including targets beyond the current drone limit.
- Keep separate native Sweeper work queues for each player so drones can reserve, collect, retarget, and finish their owner's remaining selected particles authoritatively.
- Validate and reserve client Sweeper targets through the original game's element, authorization, matter-type, and simulation-physics routines rather than the renderer-facing API.
- Admit bounded Sweeper plans through the host action-schema gate so reservation data reaches authoritative execution before the drone spawn messages.
- Re-send the complete authoritative Sweeper source footprint while drones are active and briefly after completion, clearing client particles left behind when native deferred removals do not flag their chunks.

## v0.3.5 - 2026-08-25

- Allow Sandustry's native client move transaction to finish instead of intercepting each destination as an unrelated placement request.
- Parse Sandustry's native move-event source and destination coordinates correctly for client move requests.
- Resolve move sources against the host world, remove them through the complete native cell and worker path, and validate every destination before placement.
- Retry source structures that survive deferred removal and clean unowned foundation cells from their captured footprints.
- Restore source structures when the host rejects their destination instead of allowing an incomplete move to duplicate structures.

## v0.3.4 - 2026-08-25

- Remove mushrooms, long grass, crystals, and other attached foliage on clients when their supporting terrain is removed by the host.
- Reuse Sandustry's native foliage cleanup without replaying unrelated terrain-destruction effects on clients.

## v0.3.3 - 2026-08-25

- Synchronize each player's hover state and reproduce the native hover particle cloud for remote players.
- Emit remote hover particles only while the remote player is inside the current camera view.

## v0.3.2 - 2026-08-25

- Disconnect clients from the multiplayer session whenever they return to the main menu after entering a world, preserving the exit marker across the renderer recreation performed by Sandustry and stopping before another world can be requested.
- Send an explicit leave notification before closing the client transport so the host removes the player immediately.

## v0.3.1 - 2026-08-25

- Rebuilt the multiplayer save picker around the native world hierarchy, with worlds listed separately and every manual, automatic, and exit save available behind its world.

## v0.3.0 - 2026-08-25

- Renamed LAN hosting and joining to Direct hosting and joining throughout the multiplayer interface.
- Added a configurable Direct host port, with the selected host and join ports remembered separately.
- Added best-effort UPnP TCP port mapping for online Direct hosting, including public-address status and automatic mapping cleanup when hosting stops.

## v0.2.11 - 2026-08-25

- Clear disconnected players' name labels and off-screen indicators immediately, including when the last client leaves or the host render loop is paused.

## v0.2.10 - 2026-08-25

- Validate every client grabber target through the host's native restricted-zone authorization before removing an element.

## v0.2.9 - 2026-08-25

- Restore player movement when another player closes the shared artefact choice window, matching the base game's native close cleanup.

## v0.2.8 - 2026-08-25

- Refresh the client resource HUD as soon as the authoritative host Fluxite total changes, without requiring the player to open a menu.

## v0.2.7 - 2026-08-24

- Recreated client Cryoblaster particles through the native host routine with their original launch velocity, preventing snow particles from dropping limply at the muzzle.

## v0.2.6 - 2026-08-24

- Made client drill and mining-laser use host-authoritative: clients send their tool and aim coordinates, while the host validates the request, uses the client's position as the tool origin, performs excavation, and consumes energy.
- Added sequenced tool-use results and remote drill and mining-laser presentation.

## v0.2.5 - 2026-08-24

- Added persistent per-player positions and hotbars to the host world save, allowing multiplayer clients to return with their own saved location and toolbar across sessions.

## v0.2.4 - 2026-08-23

- Fixed angled foundation demolition by capturing the structure’s actual footprint before removal, ensuring orphaned tiles outside the selected demolition area are cleaned up correctly.

## v0.2.3 - 2026-08-23

- Added a `ResizeObserver`-driven menu refresh so the Multiplayer button follows resolution changes on the next animation frame instead of waiting for the polling interval.

## v0.2.2 - 2026-08-23

- Made the Multiplayer main-menu label use the base game's responsive typography so it scales correctly at lower screen resolutions.
- Made the Multiplayer row spacing and padding respond to the native menu size without overlapping adjacent controls.

## v0.2.1 - 2026-08-23

- Preserved native directional structure variants during client placement, including cardinal-only and eight-direction buildings.

## v0.2.0 - 2026-08-23

- Kept mirrored clients paused throughout automatic saves and immediately reasserted the worker pause when saving finished.
- Added targeted post-save recovery that invalidates host row hashes and retransmits any chunks the client simulation may have touched.

## v0.1.9 - 2026-08-23

- Repaired grabber tank headers from the active spatial slots and cleared stale inactive storage.
- Resolved merged particles to their underlying material before applying the grabber type lock.
- Increased held-grabber collection responsiveness while retaining sequenced host-authoritative requests.
- Returned host-collected material to its original world cell when the matching client slot could not accept it.
- Added Steam, Microsoft Store, Xbox, and PC Game Pass installation discovery to the Windows installer.
- Rebuilt the project documentation and removed obsolete project-name, distribution, and contributor references.

## v0.1.8 - 2026-08-23

- Reconciled host world items through Sandustry's native item API so artefacts and their sprites appear correctly for clients.
- Restored the complete native replacement path for client building requests, including clearance validation, removal of the replaced structure, and authoritative placement by the host.
- Prevented the minimap unlock animation from flashing when an already-correct save is loaded.

## v0.1.7 - 2026-08-22

- Made the host authoritative for client research, building placement, and other synchronized actions.
- Synchronized factory tier unlocks in addition to individual technologies.
- Reconciled unlocked and locked research effects when loading saves while preserving valid hotbar layouts.
- Corrected client conveyor and filter animation timing.

## v0.1.6 - 2026-08-22

- Removed minimap access when the corresponding map technology is not unlocked.

## v0.1.5 - 2026-08-22

- Repaired technology state from loaded saves so unlocked buildings, tools, weapons, and map features are restored.
- Improved temporary world-save transfer and cleanup during multiplayer joins.
- Fixed client resource deductions and technology propagation.

## v0.1.4 - 2026-08-22

- Fixed client building placement so the host performs native validation and returns full, partial, or failed placement results.
- Matched client grabber pickup behavior to the host's native vacuum logic.
- Fixed replacement cleanup that could leave orphaned foundation cells.

## v0.1.1 - 2026-08-21

- Renamed the project and all compatibility surfaces to SandustryMP.
- Split the renderer implementation into networking, state, menu, and localization modules.
- Added English comments and diagnostic log messages while retaining multilingual UI localization.
- Bundled independent source copies in the distribution and Workshop packages.
