# SandustryMP changelog

All notable changes to SandustryMP are recorded here. Dates use the ISO `YYYY-MM-DD` format.

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
