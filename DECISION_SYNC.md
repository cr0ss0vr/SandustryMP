# Decision synchronization prototype

The prototype is being introduced without removing the authoritative world mirror. This keeps normal multiplayer behavior recoverable while the deterministic requirements are measured.

This branch identifies itself as mod `v0.3.10` and transport protocol 7. It must not be mixed with unpatched simulation workers.

## Implemented baseline

- The renderer retains a monotonically increasing observation epoch for diagnostics.
- A four-word `SharedArrayBuffer` is registered with the manager worker through `RegisterModSharedBuffer` (opcode 58).
- A Sandkit manager trigger is registered through `RegisterManagerTrigger` (opcode 56) at a 60 Hz interval.
- The manager trigger reads the tick being started from the manager-owned `store.meta.tick` and derives a deterministic xorshift32 seed from the session seed and tick.
- World batches carry the authoritative tick, tick seed, and session seed. A paused client adopts that clock state.
- `simulation-worker.js` is prepended with an idempotent bootstrap during installation and Workshop auto-update.
- The bootstrap replaces worker-local `Math.random()` with a per-tick xorshift32 stream derived from the authoritative tick seed and worker index. Before the clock buffer is registered it falls back to the native implementation.
- Every tenth world batch is selected as a probe batch.
- The host records canonical FNV-1a hashes for the chunks represented by that batch.
- Hashes cover `mapData`, `wallData`, `shadowMap`, `authorization`, `sim.cellIds`, and resolved element types in a fixed row-major order.
- After applying the batch, the client hashes the same chunks and returns a `dprobe` report.
- The host logs per-report and cumulative match statistics.
- The existing `wc` correction stream remains authoritative.

This baseline validates canonical state comparison and identifies transport/application mismatches. It now has a worker-owned simulation clock, but it does not yet measure independent simulation agreement because the client simulation is still paused and the game's physics still calls `Math.random()` directly.

## Required next milestone

The next implementation must make simulation inputs consume the worker clock:

1. Make worker assignment deterministic, or derive random values from stable decision coordinates rather than call order.
2. Assign client actions to a future simulation tick.
3. Apply queued actions at the manager mutation barrier for that tick.
4. Keep a bounded history of inputs and authoritative chunk corrections.
5. Add a probe mode in which a client simulates selected tick windows before correction.

Only after those probes demonstrate a low divergence rate should matching chunks be omitted from the normal mirror stream.

## Probe log

The host emits lines in this form:

```text
DECISION-PROBE Player tick 7200 epoch 12345 batch 80 matched 14 mismatched 0 total 140/140
```

Any nonzero mismatch must be investigated before using the hashes to suppress world data. Shared simulation buffers may be written by workers while the renderer samples them, so repeated mismatches in active chunks may require a worker-side snapshot barrier.
