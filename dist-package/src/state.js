// SandustryMP shared renderer state.
(() => {
	"use strict";
	window.SandustryMPState = {
		create(version) {
			return {
		version: version,
		state: null,
		gameApi: null,
		peers: new Map(),
		net: { role: "idle", transport: null },
		_lastPosSend: 0,
		_hud: null,
		_ghostCanvas: null,
		_debugDumped: false,
		// world sync
		wsx: {
			pending: new Set(),   // host: chunk indexes to send
			priority: new Set(),  // host: chunki grabber/vacuum - ZAWSZE sent first (bypasses 120 fast-lane limit)
			sweep: 0,             // host: rolling full sweep
			lastBatch: 0,
			busy: false,
			paused: false,        // client: whether sim is paused
			applyCount: 0, applyBytes: 0, statT: 0, statTxt: "",
			mismatchWarned: false,
			bpc: 0,               // host: EMA of compressed bytes per chunk, sizes each batch to a byte budget
			lastNear: 0,          // host: fast lane usage last batch, splits the budget between the two lanes
			// Congestion control. Without it the host pushes whatever the sim dirties (measured 349 KB/s)
			// into Steam's send buffer, which then grows without bound. Reliable is ORDERED, so the client
			// replays history instead of seeing the present (measured ~60 s behind).
			// Backlog kept HERE coalesces: rowH compares against the last SENT state, so a chunk touched
			// 50 times while queued sends once, current. Backlog in the network buffer does not coalesce.
			// So we measure how far behind the client is and throttle ourselves. Choppier updates beat
			// time travel.
			seq: 0,               // host: sequence number of the next wc batch, echoed back by clients
			ackSeen: false,       // host: has any client ever acked, so older clients never throttle anyone
			lag: 0,               // host: seq minus the slowest ack, in batches (1 batch is ~100 ms)
			rate: 1,              // host: byte budget multiplier driven by AIMD below
		},
		det: {
			hostEpoch: 0, remoteEpoch: 0,
			clock: null, clockState: null,
			probeSent: new Map(),
			checked: 0, matched: 0, mismatched: 0,
		},
		// struktury/zasoby/vacuum
		_applyingNet: false,      // event loop suppressor when applying changes from the network
		_subscribedState: null,
		_lastSnap: 0,
		_lastRes: 0,
		_lastVac: 0,
		// v0.5: full sync
		_pd: 0,                   // flaga: kopanie gracza (patch I)
		_projCtx: 0,              // flag: missile update (patch m)
		_sprayCtx: 0,             // flaga: spray (patch _)
		_lastEnt: 0,              // stream encji 10 Hz
		_lastMyProj: 0,
		remoteProjectiles: [],    // pociski zdalnych graczy (ghost render)
		peerPuppets: new Map(),   // id -> {puppet:PIXI.Container, parent} — prawdziwe sprite'y gracza (dotNine)
		_lastResDelta: 0, _resSnapshot: null, // resDelta (dotNine)
		_moveStash: [],           // structures:removed(byMove) waiting for a pair with :moved
		_pickedPending: new Map(),// item id -> timestamp (raised locally, waiting for host confirmation)
		_structApplied: new Map(),// structKey -> timestamp (delete protection period in reconcile)
				_grabbedCells: new Map(), // idx(x+y*W) -> ts: cells grabbed locally; retake lock before host confirms deletion (mirror)
				_placedCells: new Map(),  // idx -> timestamp for locally placed grabber cells; a sentinel blocks repeated targeting until host confirmation.
				_wasSaving: false,        // client: native save held the worker pause and still needs immediate post-save recovery
		_sndWarned: false,
			};
		},
		createProfiles({ sandustryMP, isClientSync, unwrapTypedArray, log }) {
			function profileSave(state) {
				try {
					if (!isClientSync() || !sandustryMP.wsx.paused || !sandustryMP._trustedWid) return;
					const player = state.store.player;
					if (!player || typeof player.x !== "number") return;
					const profile = { x: player.x, y: player.y, t: Date.now() };
					try { if (Array.isArray(player.inventory)) profile.inv = JSON.parse(JSON.stringify(player.inventory)); } catch (error) {}
					localStorage.setItem("smp_prof_" + sandustryMP._trustedWid, JSON.stringify(profile));
				} catch (error) {}
			}
			function profileRestore(state, worldId) {
				try {
					const rawProfile = localStorage.getItem("smp_prof_" + worldId);
					if (!rawProfile) return;
					const profile = JSON.parse(rawProfile);
					const player = state.store.player;
					if (!player) return;
					if (typeof profile.x === "number" && typeof profile.y === "number") {
						player.x = profile.x; player.y = profile.y;
						if (player.velocity) { player.velocity.x = 0; player.velocity.y = 0; }
						const playerPosition = unwrapTypedArray(state.shared.playerPos);
						if (playerPosition && playerPosition.length >= 2) { playerPosition[0] = profile.x; playerPosition[1] = profile.y; }
					}
					if (Array.isArray(profile.inv) && Array.isArray(player.inventory) && profile.inv.every((item) => item && typeof item === "object")) {
						try { player.inventory.length = 0; for (const item of profile.inv) player.inventory.push(item); } catch (error) {}
					}
					log("Client profile restored for world", worldId, "(position " + Math.round(profile.x) + "," + Math.round(profile.y) + (profile.inv ? " + inventory)" : ")"));
				} catch (error) {}
			}
			return { profileSave, profileRestore };
		}
	};
})();
