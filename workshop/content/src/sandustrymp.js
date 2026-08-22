// ============================================================================
// SandustryMP — co-op multiplayer mod for Sandustry
// Author: Cr0ss0vr
// Contributor / Wspyellow developer: dotNine (cellIds collision sync, lobby-ID join,
//   auto world transfer, off-screen player arrows, ping, FH.patterns.excavate fix)
// Renderer-side module (loaded BEFORE bundle.js).
// Host streams the world (mapData/wallData/shadowMap/cellIds mirror); the client
// runs a paused simulation and forwards its actions (dig/place/vacuum) to the host.
// ============================================================================
(() => {
	const TAG = "[SandustryMP]";
	const log = (...values) => {
		console.log(TAG, ...values);
		try {
			const line = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
			window.electron && window.electron.log && window.electron.log("info", "SandustryMP:game", line);
		} catch (e) {}
	};
	const VER = "v0.1.7";
	const AUTHOR = "Cr0ss0vr";
	const CONTRIBUTORS = "";
	const VACUUM_CAPS = [500, 1000, 1500, 2000, 2500, 3000]; // capacity table from the game code (module 6420)
	const RJ_FIRE = 11, RJ_FREEZINGICE = 12; // enuma RJ values from the current build (to createAt on the host)
	const CHUNK = 40;

	const localisation = window.SandustryMPLocalisation.create(AUTHOR);
	const LANG = localisation.LANG;
	const STRINGS = localisation.STRINGS;
	const t = localisation.t;

	const sandustryMP = (window.SandustryMP = window.SandustryMPState.create(VER));
	sandustryMP._sprayFlag = () => { sandustryMP._sprayCtx = 1; queueMicrotask(() => { sandustryMP._sprayCtx = 0; }); };
	// Host heartbeat (fix G4): `frame:update` stops while the host is paused in a menu, which otherwise stops synchronization silently.
	// `setInterval` continues during a simulation pause, so clients still receive heartbeat state.
	setInterval(() => {
		try {
			if (sandustryMP.net.role === "host" && sandustryMP.peers.size && sandustryMP.state && net) {
				const p = !!(sandustryMP.state.session && sandustryMP.state.session.paused);
				net.send({ t: "hb", p });
			}
		} catch (e) {}
	}, 1000);

	log("Renderer mod loaded", VER);

	// ------------------------------------------------------------------
	// Utilities
	// ------------------------------------------------------------------
	const encodeBase64 = (bytes) => {
		let binaryString = "";
		for (let offset = 0; offset < bytes.length; offset += 32768) binaryString += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
		return btoa(binaryString);
	};
	const decodeBase64 = (encodedText) => {
		const binaryString = atob(encodedText);
		const bytes = new Uint8Array(binaryString.length);
		for (let index = 0; index < binaryString.length; index++) bytes[index] = binaryString.charCodeAt(index);
		return bytes;
	};
	async function deflate(bytes) {
		const compressionStream = new CompressionStream("deflate-raw");
		const writer = compressionStream.writable.getWriter();
		writer.write(bytes); writer.close();
		return new Uint8Array(await new Response(compressionStream.readable).arrayBuffer());
	}
	async function inflate(bytes) {
		const decompressionStream = new DecompressionStream("deflate-raw");
		const writer = decompressionStream.writable.getWriter();
		writer.write(bytes); writer.close();
		return new Uint8Array(await new Response(decompressionStream.readable).arrayBuffer());
	}
	// access to world buffers (defensive: {date:...} or bare array)
	const unwrapTypedArray = (value) => (value && value.data && value.data.buffer ? value.data : value && value.buffer ? value : null);
	function worldBuffers(state) {
		const sharedState = state.shared || {};
		const map = unwrapTypedArray(sharedState.mapData);
		const wall = unwrapTypedArray(sharedState.wallData);
		const shadow = unwrapTypedArray(sharedState.shadowMap);
		const authorization = unwrapTypedArray(sharedState.authorization);
		const collectorGoldCount = unwrapTypedArray(sharedState.collectorGoldCount);
		// sim.cellIds (Uint32 per mobile) = ODDZIELNA layer from mapData; it is read by the player's collision
		// (`FH.player.isPositionClear` → `isCellTerrain` → `getCellId`). Without this layer, the client sees excavated terrain
		// terrain, but physically it is still "solid". Sync = client can enter the hole. (contributed by dotNine)
		const cellIds = sharedState.sim && sharedState.sim.cellIds;
		// elementData.type: Maps INDEKS element → type. Grabber/vacuum read it via getResolvedTypeFromCellId
		// (`cellId` → index → type). Mirroring only `cellIds` without `elementData` prevents clients from recognizing elements.
		// (the grabber doesn't take it). Sync of this layer (v4) fixes the grabber. index = cellId - ELEMENTS_MIN.
		const elementTypes = (sharedState.sim && sharedState.sim.elementData && sharedState.sim.elementData.type) || null;
		const width = (sharedState.mapData && sharedState.mapData.width) || (state.store.world && state.store.world.size && state.store.world.size.width) || 0;
		const height = (sharedState.mapData && sharedState.mapData.height) || (state.store.world && state.store.world.size && state.store.world.size.height) || (map && width ? map.length / 4 / width : 0);
		return { map, wall, shadow, authorization, cellIds, elementTypes, collectorGoldCount, width, height };
	}
	const ELEMENTS_MIN = 1000001, ELEMENTS_MAX = 2000000; // cellId range for elements (Lk.ELEMENTS in build 0.5.4)
	// Built structures use several terrain types for their foundation cells. In the
	// current game enum: Block/SlidingBlock variants are 15-18, conveyors and shakers
	// are 19-22, VelocitySoaker is 24, and Grower is 26. Natural Stone is 23, so this
	// must remain an explicit allow-list rather than a continuous numeric range.
	const STRUCTURE_TERRAIN_TYPES = new Set([15, 16, 17, 18, 19, 20, 21, 22, 24, 26]);
	const DET_PROBE_INTERVAL = 10; // Sample one authoritative batch per second at the current 10 Hz mirror rate.
	function hashWorldChunk(state, chunkIndex) {
		const { map, wall, shadow, authorization, cellIds, elementTypes, width, height } = worldBuffers(state);
		if (!map || !width || !height) return 0;
		const chunkGrid = chunkDims(width, height);
		const chunkX = chunkIndex % chunkGrid.cx, chunkY = Math.floor(chunkIndex / chunkGrid.cx);
		const startX = chunkX * CHUNK, startY = chunkY * CHUNK;
		const chunkWidth = Math.min(CHUNK, width - startX), chunkHeight = Math.min(CHUNK, height - startY);
		if (chunkWidth <= 0 || chunkHeight <= 0) return 0;
		const cellIds32 = cellIds ? new Uint32Array(cellIds.buffer, cellIds.byteOffset, width * height) : null;
		let hash = 0x811c9dc5;
		const addByteToHash = (value) => { hash ^= value & 0xff; hash = Math.imul(hash, 0x01000193) >>> 0; };
		for (let row = 0; row < chunkHeight; row++) {
			const cellOffset = (startY + row) * width + startX, pixelOffset = cellOffset * 4;
			for (let index = 0; index < chunkWidth * 4; index++) addByteToHash(map[pixelOffset + index]);
			for (let index = 0; index < chunkWidth; index++) addByteToHash(wall[cellOffset + index]);
			for (let index = 0; index < chunkWidth; index++) addByteToHash(shadow ? shadow[cellOffset + index] : 0);
			for (let index = 0; index < chunkWidth; index++) addByteToHash(authorization ? authorization[cellOffset + index] : 0);
			for (let index = 0; index < chunkWidth; index++) {
				const cellId = cellIds32 ? cellIds32[cellOffset + index] : 0;
				addByteToHash(cellId); addByteToHash(cellId >>> 8); addByteToHash(cellId >>> 16); addByteToHash(cellId >>> 24);
			}
			for (let index = 0; index < chunkWidth; index++) {
				const cellId = cellIds32 ? cellIds32[cellOffset + index] : 0;
				addByteToHash(elementTypes && cellId >= ELEMENTS_MIN && cellId <= ELEMENTS_MAX ? elementTypes[cellId - ELEMENTS_MIN] || 0 : 0);
			}
		}
		return hash || 1;
	}
	// A valid network element type is an integer greater than zero. Reject null, undefined, and zero from empty tank slots.
	// T[o+2] hors-bornes on a desynchronized client) - otherwise the host does createAt(...,undefined) and crashes.
	const validElement = (v) => Number.isInteger(v) && v > 0;
	let profileSave;
	let profileRestore;

	// Grabber (client): reset the cellId locally and remember it so that the grabber doesn't take it again
	// before the host confirms the deletion via the mirror. Called only on the client side (mirror renderer).
	function grabClearLocal(state, x, y) {
		try {
			const { cellIds, width, height } = worldBuffers(state);
			if (!cellIds || !width || x < 0 || y < 0 || x >= width || y >= height) return;
			const cellIndex = x + y * width;
			const cellIdArray = new Uint32Array(cellIds.buffer, cellIds.byteOffset, width * height);
			const cellId = cellIdArray[cellIndex]; // cellId of the looted element - to distinguish "same" vs. "new element caught"
			cellIdArray[cellIndex] = 0;
			sandustryMP._placedCells.delete(cellIndex); // GRAB deletes a possible sentinel PLACE of the same cell (otherwise the maps clash → re-grab blockade)
			sandustryMP._grabbedCells.set(cellIndex, { ts: performance.now(), cid: cellId });
			if ((sandustryMP._grabDiag = (sandustryMP._grabDiag || 0) + 1) <= 60) log("GRAB pick @", x, y, "(cellId->0, forward)");
		} catch (e) {}
	}
	// Grabber PLACE (client): enter a sentinel (non-zero cellId) into the cell where we put the element -
	// the put away loop reads LOKALNE cellIds and the "still empty" cell (mirror lag) would target again
	// another tank slot; host createAt no-ops on the occupied one → the second element would be lost.
	// `cellIds` do not control rendering (`mapData` does); this sentinel affects logic only and the mirror replaces it with the real ID.
	const GRAB_SENTINEL = 1;
	function grabSetLocal(state, x, y) {
		try {
			const { cellIds, width, height } = worldBuffers(state);
			if (!cellIds || !width || x < 0 || y < 0 || x >= width || y >= height) return;
			const cellIndex = x + y * width;
			new Uint32Array(cellIds.buffer, cellIds.byteOffset, width * height)[cellIndex] = GRAB_SENTINEL;
			sandustryMP._grabbedCells.delete(cellIndex); // PLACE deletes a possible GRAB tag of the same cell
			sandustryMP._placedCells.set(cellIndex, performance.now());
			if ((sandustryMP._grabDiag = (sandustryMP._grabDiag || 0) + 1) <= 60) log("GRAB place @", x, y, "(sentinel, forward)");
		} catch (e) {}
	}
	// Adaptacyjny mirror protection period: 3×RTT+300ms (min 1200, max 3000) - at ping 300ms+
	// the 600ms constant was shorter than the act→host→chunk round and the duplicate bug came back under the lag.
	function grabGraceMs() {
		let ping = 0;
		for (const p of sandustryMP.peers.values()) if (p.ping != null) { ping = p.ping; break; } // client has 1 peer (host)
		return Math.min(3000, Math.max(1200, 3 * ping + 300));
	}
	// Some function names exist in multiple FH namespaces and do not have equivalent behavior.
	// Potwierdzone (dotNine): FH.world.excavate "looks good but doesn't do anything" and
	// `FH.patterns.excavate` calls the real excavation function, so preferred namespaces must be checked first.
	function findApi(fnName, preferredNs) {
		const gameApi = sandustryMP.gameApi;
		if (!gameApi) return null;
		// preferredNs: string or array (names vary between builds: 0.5.3=patterns, current=excavation)
		const prefs = Array.isArray(preferredNs) ? preferredNs : (preferredNs ? [preferredNs] : []);
		for (const ns of prefs) if (gameApi[ns] && typeof gameApi[ns][fnName] === "function") return gameApi[ns][fnName].bind(gameApi[ns]);
		for (const ns of Object.keys(gameApi)) {
			try {
				if (gameApi[ns] && typeof gameApi[ns][fnName] === "function") return gameApi[ns][fnName].bind(gameApi[ns]);
				// one level deeper (e.g. FH.world.patterns.excavate)
				if (gameApi[ns] && typeof gameApi[ns] === "object") for (const sub of Object.keys(gameApi[ns])) {
					if (gameApi[ns][sub] && typeof gameApi[ns][sub][fnName] === "function") return gameApi[ns][sub][fnName].bind(gameApi[ns][sub]);
				}
			} catch (e) {}
		}
		return null;
	}
	function managerWorker(state) {
		try { return state.environment.multithreading.simulation.manager; } catch (e) { return null; }
	}
	const DECISION_CLOCK_KEY = "sandustrymp.clock.v1";
	const DECISION_CLOCK_WORDS = 4; // current tick, tick seed, session seed, registration marker
	function newDecisionSeed() {
		const random = new Uint32Array(1);
		crypto.getRandomValues(random);
		return random[0] || 0x6d2b79f5;
	}
	function decisionClockTick(state) {
		const mods = state.shared && state.shared.mods;
		const clock = mods && mods["sandustrymp.clock.v1"];
		if (!clock) return;
		// Manager triggers run immediately before cell dispatch; this identifies the tick being started.
		const tick = (((state.store && state.store.meta && state.store.meta.tick) || 0) + 1) >>> 0;
		Atomics.store(clock, 0, tick);
		let seed = (Atomics.load(clock, 2) ^ tick) >>> 0;
		seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
		Atomics.store(clock, 1, seed >>> 0);
	}
	function ensureDecisionClock(state) {
		if (!state || sandustryMP.det.clockState === state && sandustryMP.det.clock) return sandustryMP.det.clock;
		const manager = managerWorker(state);
		if (!manager || typeof SharedArrayBuffer === "undefined") return null;
		try {
			const buffer = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT * DECISION_CLOCK_WORDS);
			const clock = new Uint32Array(buffer);
			if (sandustryMP.net.role === "host") clock[2] = newDecisionSeed();
			clock[3] = 1;
			state.shared.mods || (state.shared.mods = {});
			state.shared.mods[DECISION_CLOCK_KEY] = clock;
			manager.postMessage([58, DECISION_CLOCK_KEY, buffer, "uint32"]);
			const simulation = state.environment && state.environment.multithreading && state.environment.multithreading.simulation;
			if (simulation && simulation.postAll) simulation.postAll(state, [58, DECISION_CLOCK_KEY, buffer, "uint32"]);
			manager.postMessage([56, DECISION_CLOCK_KEY, decisionClockTick.toString(), {
				interval: 1000 / 60, sequentialRuns: false, extra: null,
			}]);
			sandustryMP.det.clock = clock; sandustryMP.det.clockState = state;
			log("DECISION-CLOCK registered at the manager's 60 Hz tick boundary");
			return clock;
		} catch (e) {
			log("DECISION-CLOCK registration failed:", e.message);
			return null;
		}
	}
	function decisionClockSnapshot() {
		const clock = sandustryMP.det.clock;
		return clock ? {
			tick: Atomics.load(clock, 0) >>> 0,
			seed: Atomics.load(clock, 1) >>> 0,
			base: Atomics.load(clock, 2) >>> 0,
		} : { tick: 0, seed: 0, base: 0 };
	}
	function acceptRemoteDecisionClock(msg) {
		const clock = sandustryMP.det.clock;
		if (!clock || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || typeof msg.ct !== "number") return;
		Atomics.store(clock, 0, msg.ct >>> 0);
		if (sandustryMP.state && sandustryMP.state.store && sandustryMP.state.store.meta) sandustryMP.state.store.meta.tick = msg.ct >>> 0;
		if (typeof msg.cs === "number") Atomics.store(clock, 1, msg.cs >>> 0);
		if (typeof msg.cb === "number") Atomics.store(clock, 2, msg.cb >>> 0);
	}
	function resetDecisionClockSession() {
		const clock = sandustryMP.det.clock;
		if (!clock) return;
		Atomics.store(clock, 0, 0); Atomics.store(clock, 1, 0);
		Atomics.store(clock, 2, sandustryMP.net.role === "host" ? newDecisionSeed() : 0);
	}

	const networkModule = window.SandustryMPNetwork.create({ sandustryMP, log, t, resetWorldQueue: (...args) => resetWorldQueue(...args), updateLobbyIdDisplay: (...args) => updateLobbyIdDisplay(...args), showInviteButton: (...args) => showInviteButton(...args), resetDecisionClockSession: (...args) => resetDecisionClockSession(...args), enqueueFullWorld: (...args) => enqueueFullWorld(...args), sendWorld: (...args) => sendWorld(...args), profileSave: (...args) => profileSave(...args), removePeerPuppet: (...args) => removePeerPuppet(...args), removeAllPeerPuppets: (...args) => removeAllPeerPuppets(...args), updatePingDisplay: (...args) => updatePingDisplay(...args), setClientPaused: (...args) => setClientPaused(...args), updatePanel: (...args) => updatePanel(...args), renderLobby: (...args) => renderLobby(...args), handleMsg: (...args) => handleMsg(...args) });
	const { net, setStatus, setSyncInfo, addChat, isClientSync, isHostSync } = networkModule;
	({ profileSave, profileRestore } = window.SandustryMPState.createProfiles({ sandustryMP, isClientSync, unwrapTypedArray, log }));

	function handleMsg(from, msg) {
		if (msg.t === "relay") { handleMsg(msg.from, msg.msg); return; }
		if (msg.t === "ping") { try { net.send({ t: "pong", ts: msg.ts }, from); } catch (e) {} return; }
		if (msg.t === "pong") {
			const p = sandustryMP.peers.get(from);
			if (p && typeof msg.ts === "number") { const rtt = performance.now() - msg.ts; p.ping = p.ping != null ? Math.round(p.ping * 0.7 + rtt * 0.3) : Math.round(rtt); }
			return;
		}
		if (msg.t === "pos") {
			let p = sandustryMP.peers.get(from);
			const now0 = performance.now();
			if (!p) { p = { nick: "?", x: msg.x, y: msg.y, tx: msg.x, ty: msg.y, vx: 0, vy: 0, tUpdate: now0, lastSeen: 0 }; sandustryMP.peers.set(from, p); }
			if (!p._gotPos) { p._gotPos = true; log("first position from", from, "->", msg.x, msg.y); }
			// speed from RZECZYWISTEGO dt (in the case of a large break, we assume 0 so that dead-reckoning does not "shoot" the player) (dotNine)
			const rawDt = now0 - (p.tUpdate || now0);
			if (rawDt < 1 || rawDt > 1500) { p.vx = 0; p.vy = 0; }
			else { p.vx = (msg.x - p.tx) / rawDt; p.vy = (msg.y - p.ty) / rawDt; const vm = Math.hypot(p.vx, p.vy); if (vm > 3) { const s = 3 / vm; p.vx *= s; p.vy *= s; } }
			p.tx = msg.x; p.ty = msg.y; p.tUpdate = now0; p.lastSeen = now0;
			p.tools = msg.tools || [];
			if (msg.facing === 1 || msg.facing === -1) p.syncedFacing = msg.facing;
			p.aim = typeof msg.aim === "number" ? msg.aim : 0;
			p.trailAlpha = typeof msg.trail === "number" ? msg.trail : 0;
			// action preview (pose phantom / grabber reticle) - cursor in the world + build intent
			p.mwx = typeof msg.mwx === "number" ? msg.mwx : null;
			p.mwy = typeof msg.mwy === "number" ? msg.mwy : null;
			p.bt = msg.bt != null ? msg.bt : null;
			p.boffs = Array.isArray(msg.boffs) ? msg.boffs : null;
			if (p.x === 0 && p.y === 0) { p.x = msg.x; p.y = msg.y; }
		} else if (msg.t === "hello") {
			const p = sandustryMP.peers.get(from) || { x: 0, y: 0, tx: 0, ty: 0, lastSeen: performance.now() };
			p.nick = msg.nick || "?";
			sandustryMP.peers.set(from, p);
			if (!p.joinAnnounced) { p.joinAnnounced = true; addChat("★", t("chat_joined", p.nick)); }
			setStatus(t("players", sandustryMP.peers.size + 1));
			if (!p.modVersionRequested) {
				p.modVersionRequested = true;
				try { net.send({ t: "mver", v: VER, gf: sandustryMP._gameFp || null }, from); } catch (e) {}
			}
			// old mod (≤0.9.7) doesn't know mver and won't respond - after 5 seconds no response ALARM (case of "man on 0.9.0")
			setTimeout(() => {
				const pp = sandustryMP.peers.get(from);
				if (pp && !pp.modVer) {
					setStatus(t("ver_mismatch") + " [" + (pp.nick || from) + ": OLD mod (<= 0.9.7)! / you: " + VER + "]", "#f66");
					log("PEER IS USING AN OLD MOD VERSION (no mver response):", pp.nick || from, "— must run install.bat!");
				}
			}, 5000);
			// The client requests a full mirror with `resync` after loading the host transfer save.
		} else if (msg.t === "mver") {
			const p = sandustryMP.peers.get(from); if (p) p.modVer = msg.v;
			if (msg.v !== VER) {
				setStatus(t("ver_mismatch") + " [" + ((p && p.nick) || from) + ": " + msg.v + " / you: " + VER + "]", "#f66");
				log("MOD VERSION MISMATCH:", from, "has", msg.v, "— local version is", VER);
			} else log("Mod version matches for", (p && p.nick) || from, "->", msg.v);
			// build imprint GRY (guard R3): different builds = different element enums/anchors → warn instead of silent corruption
			if (msg.gf && sandustryMP._gameFp && msg.gf !== sandustryMP._gameFp) {
				setStatus("⚠ DIFFERENT GAME BUILDS! [" + ((p && p.nick) || from) + "] — update the game on both sides", "#f66");
				log("GAME BUILD MISMATCH:", from, "has", msg.gf, "— local build is", sandustryMP._gameFp);
			}
		} else if (msg.t === "wi") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady && sandustryMP.state && sandustryMP.wsx.paused) { sandustryMP._applyingNet = true; try { applyWorldItems(sandustryMP.state, msg.wi); } finally { sandustryMP._applyingNet = false; } }
		} else if (msg.t === "chat") {
			const nick = (sandustryMP.peers.get(from) && sandustryMP.peers.get(from).nick) || "?";
			addChat(nick, String(msg.m || "").slice(0, 200));
		} else if (msg.t === "hb") {
			// host heartbeat (fix G4): the only signal that passes when the host pauses (frame stands still)
			if (sandustryMP.net.role === "client") {
				sandustryMP._lastHb = performance.now();
				if (msg.p && !sandustryMP._hostPausedShown) { sandustryMP._hostPausedShown = true; setStatus(t("host_paused"), "#fd5"); }
				else if (!msg.p && sandustryMP._hostPausedShown) { sandustryMP._hostPausedShown = false; setStatus(t("players", sandustryMP.peers.size + 1)); }
			}
		} else if (msg.t === "wc") {
			if (sandustryMP._baseWorldReady) applyWorldBatch(msg).catch((e) => log("apply error:", e.message));
		} else if (msg.t === "wcack") {
			// Client acks the last APPLIED batch. This is the only signal we have for how far behind it is:
			// Steam's send buffer is invisible to us and sendP2PPacket never reports that it is full.
			if (sandustryMP.net.role === "host" && typeof msg.sq === "number") {
				const p = sandustryMP.peers.get(from);
				if (p) { p.ackSq = msg.sq; sandustryMP.wsx.ackSeen = true; } // per peer, so the slowest one governs
			}
		} else if (msg.t === "dprobe") {
			if (sandustryMP.net.role === "host" && typeof msg.sq === "number" && Array.isArray(msg.h)) {
				const expected = sandustryMP.det.probeSent.get(msg.sq);
				if (!expected) return;
				let ok = 0, bad = 0;
				for (const pair of msg.h) {
					if (!Array.isArray(pair) || pair.length < 2) continue;
					if (expected.get(pair[0]) === (pair[1] >>> 0)) ok++; else bad++;
				}
				sandustryMP.det.checked += ok + bad; sandustryMP.det.matched += ok; sandustryMP.det.mismatched += bad;
				const peer = sandustryMP.peers.get(from); if (peer) { peer.detEpoch = msg.ep; peer.detTick = msg.ct; }
				log("DECISION-PROBE", (peer && peer.nick) || from, "tick", msg.ct, "epoch", msg.ep, "batch", msg.sq, "matched", ok, "mismatched", bad,
					"total", sandustryMP.det.matched + "/" + sandustryMP.det.checked);
			}
		} else if (msg.t === "act") {
			if (sandustryMP.net.role === "host") replayAction(msg, from);
		} else if (msg.t === "st") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady) applyNetStructs(msg);
		} else if (msg.t === "placeResult") {
			if (sandustryMP.net.role === "client") applyPlacementResult(msg);
		} else if (msg.t === "snap") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady) applySnapshot(msg).catch((e) => log("snap error:", e.message));
		} else if (msg.t === "res") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady) applyResources(msg);
		} else if (msg.t === "tech") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady && sandustryMP.state && msg.id) applySyncedTechUnlock(sandustryMP.state, msg.id);
		} else if (msg.t === "tier") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady && sandustryMP.state) applySyncedFactoryTier(sandustryMP.state, msg.level);
		} else if (msg.t === "resDelta") {
			if (sandustryMP.net.role === "host") applyResourceDelta(msg);
		} else if (msg.t === "ent") {
			if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady) applyEntities(msg);
		} else if (msg.t === "myproj") {
			const p = sandustryMP.peers.get(from);
			if (p) p.projectiles = msg.list || [];
		} else if (msg.t === "snd") {
			playRemoteSound(msg);
		} else if (msg.t === "vacres") {
			if (sandustryMP.net.role === "client") clientApplyVacuumResult(msg);
		} else if (msg.t === "grabres") {
			if (sandustryMP.net.role === "client") {
				const pendingGrab = sandustryMP._grabPending;
				if (pendingGrab && Number.isInteger(msg.q) && msg.q !== pendingGrab.q) return;
				sandustryMP._grabPending = null;
				clientFillGrabTank(msg.types || [], msg.offs || null);
			}
		} else if (msg.t === "grabRef") {
			// REFUND put (R5): host failed to put item (cell busy) → put to tank
			if (sandustryMP.net.role === "client" && typeof msg.et === "number" && msg.et > 0) clientFillGrabTank([msg.et], null);
		} else if (msg.t === "resync") {
			if (sandustryMP.net.role === "host") { log("resync from", from, "-> full world to queue"); enqueueFullWorld(); sandustryMP._lastSnap = 0; }
		} else if (msg.t === "world-req") {
			// client requests SAVE (self-healing: reconnect / auto-send did not work) - rate-limit 15 s
			if (sandustryMP.net.role === "host" && performance.now() - (sandustryMP._lastWorldReqT || 0) > 15000) {
				sandustryMP._lastWorldReqT = performance.now();
				log("world-req from", from, "-> I'm sending the save");
				sendWorld();
			}
		} else if (msg.t === "world-wait") {
			// the host hasn't entered the world yet - we're waiting patiently, the world-req attempt doesn't work
			if (sandustryMP.net.role === "client") {
				sandustryMP._worldReqN = Math.max(0, (sandustryMP._worldReqN || 0) - 1);
				setStatus(t("waiting_host_world"), "#fd5");
			}
		} else if (msg.t === "world-begin") {
			// Starting a new transfer during reception mixes packet indexes and creates a `world-need` storm.
			// (fix TCentraL "went crazy with the retrys"): ignore until the current reception ends.
			if (sandustryMP._worldRx && !sandustryMP._worldRx.done) { log("world-begin ignored because the previous transfer is still in progress"); return; }
			sandustryMP._gotHostWorld = true; // we received the world FROM the host → we trust its worldId when both in game (see applyWorldBatch)
			sandustryMP._worldRx = { tid: msg.tid, saveId: msg.saveId, name: msg.name, total: msg.chunks, parts: new Array(msg.chunks), got: 0, from, done: false, ended: false };
			log("world-begin: tid", msg.tid, "-", msg.name, "-", msg.chunks, "packets,", Math.round((msg.size || 0) / 1024), "KB");
			setStatus(t("receiving", 0, msg.chunks), "#ff5");
			scheduleRxCheck();
		} else if (msg.t === "world-chunk" && sandustryMP._worldRx) {
			// packet with INNEGO transfer than the current one = interleaving (the host autosaved between shipments) —
			// letting it in merges saves from two versions of the world → ZEPSUTY world (derErste67 report)
			if (sandustryMP._worldRx.tid !== undefined && msg.tid !== undefined && msg.tid !== sandustryMP._worldRx.tid) {
				if (!sandustryMP._tidDropLogged) { sandustryMP._tidDropLogged = true; log("Rejected world chunk from another transfer (tid " + msg.tid + " ≠ " + sandustryMP._worldRx.tid + ")"); }
				return;
			}
			if (sandustryMP._worldRx.parts[msg.i] === undefined) { sandustryMP._worldRx.parts[msg.i] = msg.data; sandustryMP._worldRx.got++; }
			if (sandustryMP._worldRx.got % 20 === 0 || sandustryMP._worldRx.got === sandustryMP._worldRx.total)
				setStatus(t("receiving", sandustryMP._worldRx.got, sandustryMP._worldRx.total), "#ff5");
			maybeFinishRx();
		} else if (msg.t === "world-end" && sandustryMP._worldRx) {
			if (sandustryMP._worldRx.tid !== undefined && msg.tid !== undefined && msg.tid !== sandustryMP._worldRx.tid) return;
			sandustryMP._worldRx.ended = true;
			maybeFinishRx();
		} else if (msg.t === "world-need") {
			// host: client requests missing pieces -> retry them (priority)
			if (sandustryMP._wtx && Array.isArray(msg.idx)) for (const i of msg.idx) if (sandustryMP._wtx.parts[i] !== undefined) sandustryMP._wtx.queue.push(i);
			pumpWtx();
		}
	}

	function missingRxIndices() {
		const worldReceive = sandustryMP._worldRx; if (!worldReceive) return [];
		const miss = [];
		for (let i = 0; i < worldReceive.total; i++) if (worldReceive.parts[i] === undefined) miss.push(i);
		return miss;
	}
	function maybeFinishRx() {
		const worldReceive = sandustryMP._worldRx; if (!worldReceive || worldReceive.done) return;
		if (worldReceive.got < worldReceive.total) return;
		worldReceive.done = true; sandustryMP._worldRx = null;
		if (sandustryMP._rxTimer) { clearTimeout(sandustryMP._rxTimer); sandustryMP._rxTimer = null; }
		try {
			const bytes = decodeBase64(worldReceive.parts.join(""));
			window.electron.importSave(bytes).then(async (r) => {
				if (r && r.success === false) { setStatus(t("import_err", r.error), "#f66"); return; }
				sandustryMP._worldRxDone = true; // we have a world in this session → world-req turns off
				log("World import OK:", worldReceive.name, bytes.length, "bytes");
				// Auto-load: If FH.game.load exists, jump straight into the game (no manual Load Game). (contributed by dotNine)
				const saveId = r && r.metaData && r.metaData.id;
				if (!saveId) { setStatus(t("import_err", "missing imported save id"), "#f66"); return; }
				if (worldReceive.saveId && saveId !== worldReceive.saveId) log("Imported transfer save id differs from the host id:", saveId, worldReceive.saveId);
				const previousLastPlayed = getLastPlayedGame();
				// Reload loop fix (TCentraL, "reloading the same map over and over"): another transfer
				// Receiving the same world must not remove the player from the game; skip loading when the mirror or another load is active.
				// Auto-load only once per session (ZeroHazard, "reload every 10 s"); repeated transfers
				// (e.g. peer-hello cycle on an overloaded P2P) cannot repeatedly interrupt the player to load -
				// subsequent transfer saves are discarded because they are transport snapshots, not user saves.
				if (sandustryMP.wsx.everApplied || sandustryMP._loadingWorld || sandustryMP._autoLoadedOnce) {
					log("Auto-load skipped because the mirror is active, loading is in progress, or this session already auto-loaded; removing temporary transfer save");
					await removeTransferSave(saveId, previousLastPlayed);
					setStatus(t("world_imported", worldReceive.name), "#5f5");
					return;
				}
				sandustryMP._autoLoadedOnce = true;
				if (saveId && sandustryMP.gameApi && sandustryMP.gameApi.game && typeof sandustryMP.gameApi.game.load === "function" && sandustryMP.state) {
					try {
						sandustryMP._loadingWorld = true; // Prevent mirror writes during loading to avoid large-map freezes.
						setStatus(t("loading_world"), "#ff5"); // largemap = minutes; without it it looks like crap
						// FH.game.load navigates to a fresh renderer and returns immediately. Preserve
						// cleanup/trust metadata across that navigation; the new renderer consumes it
						// only after the imported world has actually been captured.
						localStorage.setItem("smp_pending_transfer_load", JSON.stringify({ saveId, previousLastPlayed, name: worldReceive.name }));
						log("Navigating to imported host save:", saveId);
						sandustryMP.gameApi.game.load(sandustryMP.state, saveId);
						return;
					} catch (e) {
						sandustryMP._loadingWorld = false;
						localStorage.removeItem("smp_pending_transfer_load");
						await removeTransferSave(saveId, previousLastPlayed);
						log("auto-load failed, fallback on manual Load Game:", e.message);
					}
				}
				else await removeTransferSave(saveId, previousLastPlayed);
				setStatus(t("world_imported", worldReceive.name), "#5f5");
			}).catch((e) => setStatus(t("import_err", e.message), "#f66"));
		} catch (e) { setStatus(t("decode_err", e.message), "#f66"); }
	}
	// every 700 ms: if chunks are missing, ask the host for them again (recovery from Steam P2P)
	function scheduleRxCheck() {
		if (sandustryMP._rxTimer) clearTimeout(sandustryMP._rxTimer);
		sandustryMP._rxTimer = setTimeout(() => {
			const worldReceive = sandustryMP._worldRx;
			if (!worldReceive || worldReceive.done) return;
			const miss = missingRxIndices();
			if (miss.length) {
				net.send({ t: "world-need", idx: miss.slice(0, 200) }, worldReceive.from);
				setStatus(t("receiving", worldReceive.got, worldReceive.total) + " (recovering " + miss.length + ")", "#ff5");
			}
			scheduleRxCheck();
		}, 700);
	}

	// ------------------------------------------------------------------
	// WORLD SYNC - HOST: dirty chunk mirror stream
	// ------------------------------------------------------------------
	function chunkDims(worldWidth, worldHeight) { return { cx: Math.ceil(worldWidth / CHUNK), cy: Math.ceil(worldHeight / CHUNK) }; }

	// HOST: mark cell chunk (x,y) as "dirty" for mirror shipping. KLUCZOWE for grabber/vacuum:
	// Mod calls to `FH.elements.createAt/removeAt` do not always set `chunkShouldUpdate`, so the mirror may skip the chunk.
	// the client never gets the postponed item (until the host starts the zone again). Wymuszamy shipping here.
	function markCellDirty(state, x, y) {
		try {
			if (sandustryMP.net.role !== "host") return;
			const { width, height } = worldBuffers(state);
			if (!width || x < 0 || y < 0 || x >= width || y >= height) return;
			const chunkGrid = chunkDims(width, height);
			const chunkX = Math.floor(x / CHUNK), chunkY = Math.floor(y / CHUNK);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // + neighbors (element may affect edge)
				const neighborX = chunkX + dx, neighborY = chunkY + dy;
				if (neighborX >= 0 && neighborY >= 0 && neighborX < chunkGrid.cx && neighborY < chunkGrid.cy) {
					const chunkIndex = neighborX + neighborY * chunkGrid.cx;
					sandustryMP.wsx.pending.add(chunkIndex); sandustryMP.wsx.priority.add(chunkIndex);
				}
			}
		} catch (e) {}
	}

	function enqueueFullWorld() {
		if (!sandustryMP.state) return;
		const { width, height } = worldBuffers(sandustryMP.state);
		if (!width) return;
		const chunkGrid = chunkDims(width, height);
		for (let chunkIndex = 0; chunkIndex < chunkGrid.cx * chunkGrid.cy; chunkIndex++) sandustryMP.wsx.pending.add(chunkIndex);
		if (sandustryMP.wsx.rowH) sandustryMP.wsx.rowH.clear(); // full re-send: row-delta cannot skip "unchanged" rows (new client doesn't have them)
		log("Full world queued:", chunkGrid.cx * chunkGrid.cy, "chunks");
	}

	// Mirror queue and congestion state are SESSION state, like _grabbedCells and _fireQ. They were the
	// only part never reset. A host that stopped and hosted again started with the previous session's
	// backlog, and worse, with row hashes from the previous world, so chunks counted as "unchanged" and
	// were never sent at all.
	function resetWorldQueue() {
		sandustryMP.wsx.pending.clear();
		sandustryMP.wsx.priority.clear();
		if (sandustryMP.wsx.rowH) sandustryMP.wsx.rowH.clear();   // stale hashes would suppress sends in the new world
		sandustryMP.wsx.sweep = 0;
		sandustryMP.wsx.bpc = 0; sandustryMP.wsx.lastNear = 0;    // re-measure chunk cost, the new world compresses differently
		sandustryMP.wsx.seq = 0; sandustryMP.wsx.ackSeen = false; sandustryMP.wsx.lag = 0; sandustryMP.wsx.rate = 1; // start un-throttled
		sandustryMP.det.hostEpoch = 0; sandustryMP.det.remoteEpoch = 0; sandustryMP.det.probeSent.clear();
		sandustryMP.det.checked = 0; sandustryMP.det.matched = 0; sandustryMP.det.mismatched = 0;
		if (sandustryMP._remoteVacuumTools) sandustryMP._remoteVacuumTools.clear();
		if (sandustryMP._vacuumLast) sandustryMP._vacuumLast.clear();
		sandustryMP._vacSeq = 0; sandustryMP._vacAckSeq = 0;
		if (sandustryMP._pendingPlacements) sandustryMP._pendingPlacements.clear();
		sandustryMP._placementSeq = 0;
		sandustryMP._grabPending = null;
		sandustryMP._grabRequestSequence = 0;
		resetDecisionClockSession();
	}

	function scanDirty(state) {
		try {
			const flags = state.shared.sim && state.shared.sim.chunkShouldUpdate;
			if (!flags) return;
			for (let chunkIndex = 0; chunkIndex < flags.length; chunkIndex++) if (flags[chunkIndex]) sandustryMP.wsx.pending.add(chunkIndex);
		} catch (e) {}
	}

	async function maybeSendBatch(state) {
		const worldSync = sandustryMP.wsx;
		const now = performance.now();
		if (worldSync.busy || now - worldSync.lastBatch < 100) return;
		const { map, wall, shadow, authorization, cellIds, elementTypes, collectorGoldCount, width: worldWidth, height: worldHeight } = worldBuffers(state);
		if (!map || !worldWidth) return;
		const cellIdArray = cellIds ? new Uint32Array(cellIds.buffer, cellIds.byteOffset, worldWidth * worldHeight) : null; // to read element type per cell (v4)
		const chunkGrid = chunkDims(worldWidth, worldHeight);
		const total = chunkGrid.cx * chunkGrid.cy;
		// rolling sweep - self-repair of missed chunks (4 per batch)
		for (let k = 0; k < 4; k++) { worldSync.pending.add(worldSync.sweep % total); worldSync.sweep++; }
		if (!worldSync.pending.size) return;
		// --- Congestion control: how far behind is the SLOWEST client? ---
		// Clients ack the last APPLIED batch, so lag catches a saturated link and a client that cannot
		// keep up applying. A client that never acks (older mod version) throttles nobody, fail open.
		{
			let minAck = null;
			for (const p of sandustryMP.peers.values()) if (typeof p.ackSq === "number" && (minAck === null || p.ackSq < minAck)) minAck = p.ackSq;
			if (worldSync.ackSeen && minAck !== null) {
				worldSync.lag = Math.max(0, worldSync.seq - minAck);  // in batches, so lag 600 literally reads as 60 s behind
				// AIMD with a 4..8 dead zone. The measurement carries ~1 batch of ack age plus RTT, so a
				// healthy link sits around 2-3. Thresholds have to clear that noise, otherwise we would
				// throttle a connection with nothing wrong with it.
				if (worldSync.lag > 8) worldSync.rate = Math.max(0.03, worldSync.rate * 0.85);        // over 0.8 s behind, cut hard
				else if (worldSync.lag <= 4) worldSync.rate = Math.min(1, worldSync.rate * 1.05);     // keeping up, give back slowly
				// Hard stop. The buffer is so full that shrinking batches cannot drain it in time. Send
				// nothing at all: pending grows here instead, where chunks coalesce, so the client gets
				// one current state rather than replaying every intermediate frame in order.
				if (worldSync.lag > 25) {
					if (now - (worldSync.stallLogT || 0) > 2000) { worldSync.stallLogT = now; log("CONGESTION: client", worldSync.lag, "batches behind (~" + Math.round(worldSync.lag / 10) + " s), pausing sends, queue", worldSync.pending.size); }
					worldSync.lastBatch = now; // hold the 100 ms cadence while stalled, else the sweep runs every frame
					return;
				}
			} else worldSync.lag = 0;
		}
		worldSync.busy = true; worldSync.lastBatch = now;
		try {
			// DWA PASMA (fix "queue 8600, client sees the world from 20s ago" - a large map gets dirty faster
			// than the old limit of 40 per batch, while distance sorting starved distant chunks indefinitely):
			// fast lane = WSZYSTKIE dirty within FAST_R radius of any player (this is what players see - always fresh),
			// slow lane = batch of oldest of the rest (Set iterates in insertion order → FIFO, no starvation).
			//
			// Adaptive budget. slowN used to be FIXED (20 or 40), so the distant lane drain never grew with the
			// backlog. A distant chunk's delay is |distant| / slowN, which rose linearly with base size and time
			// played. Now the portion grows with the queue but is capped by a BYTE budget (bpc is the
			// measured average compressed chunk size) scaled by worldSync.rate from the controller above.
			const anchors = [{ x: state.store.player.x / 4, y: state.store.player.y / 4 }];
			for (const p of sandustryMP.peers.values()) anchors.push({ x: p.tx / 4, y: p.ty / 4 });
			const FAST_R = 24 * CHUNK; // ~2 screens around the player (Manhattan, in mobile)
			const budget = Math.floor(96 * 1024 * worldSync.rate);  // ~96 KB compressed per batch, a 960 KB/s ceiling at rate 1
			const bpc = worldSync.bpc || 512;                       // measured compressed bytes per chunk, updated after deflate
			// Floor of 2, not 8. At the measured bpc of ~2 KB a floor of 8 still held ~310 KB/s, which is
			// nearly the 349 KB/s that caused the jam: the controller had nowhere to go and degenerated
			// into pure on/off stalling.
			const maxN = Math.max(2, Math.min(400, Math.floor(budget / bpc)));
			const nearN = Math.min(120, maxN);              // what players can actually see gets the budget first
			// Fast lane usage from the PREVIOUS batch, which is stable frame to frame. Without it we
			// reserved all 120 slots even when nothing near the players was dirty, so the distant lane got
			// scraps on a link that was doing nothing.
			const nearEst = Math.min(nearN, worldSync.lastNear || 0);
			// The floor min(20, maxN) must not exceed maxN, otherwise throttling would never take effect
			const slowN = Math.max(Math.min(20, maxN), Math.min(maxN - nearEst, Math.ceil(worldSync.pending.size / 20)));
			const nearbyChunks = [], distantChunks = [];
			for (const a of worldSync.pending) {
				// Early break. The Set is FIFO, so the first nearN and slowN hits are EXACTLY the chunks a
				// full scan would pick. Without it every batch walked the WHOLE queue (O(|pending|)) and
				// allocated a distantChunks array of that size 10x per second, on the renderer thread inside the
				// frame hook. Bigger backlog gave longer frames, fewer batches per second, and a bigger
				// backlog again, which is why lag grew the longer a session ran.
				if (nearbyChunks.length >= nearN && distantChunks.length >= slowN) break;
				const ax = (a % chunkGrid.cx) * CHUNK, ay = Math.floor(a / chunkGrid.cx) * CHUNK;
				let dm = 1e9;
				for (const an of anchors) { const dd = Math.abs(ax - an.x) + Math.abs(ay - an.y); if (dd < dm) dm = dd; }
				if (dm <= FAST_R) { if (nearbyChunks.length < nearN) nearbyChunks.push(a); }  // cap is budget driven now, was a fixed 120
				else if (distantChunks.length < slowN) distantChunks.push(a);                     // stop at slowN, was collecting every distantChunks chunk
			}
			worldSync.lastNear = nearbyChunks.length; // feeds nearEst on the next batch
			// Priority first (grabber/vacuum): always sent, bypassing the nearby/distant limit.
			const priorityChunks = worldSync.priority.size ? [...worldSync.priority] : [];
			worldSync.priority.clear();
			// distantChunks is already capped to slowN by the loop above, so the old distantChunks.slice(0, slowN) is redundant
			const selectedChunkIndexes = priorityChunks.concat(nearbyChunks.filter((i) => !priorityChunks.includes(i)), distantChunks.filter((i) => !priorityChunks.includes(i)));
			for (const i of selectedChunkIndexes) worldSync.pending.delete(i);
			// v4 serialization: [u16 cx][u16 cy][u8 chunkWidth][u8 chunkHeight] + per-cell: 4 map + 1 wall + 1 shadow + 1 authorization + 4 cellIds + 1 elemType = 12 B
			const serializedChunks = [], serializedChunkIndexes = [];
			let size = 0;
			let fogSkipped = 0;
			for (const chunkIndex of selectedChunkIndexes) {
				const chunkX = chunkIndex % chunkGrid.cx, chunkY = Math.floor(chunkIndex / chunkGrid.cx);
				const startX = chunkX * CHUNK, startY = chunkY * CHUNK;
				const chunkWidth = Math.min(CHUNK, worldWidth - startX), chunkHeight = Math.min(CHUNK, worldHeight - startY);
				const collectorWorldScale = 4;
				const collectorWidth = Math.ceil(worldWidth / collectorWorldScale);
				const collectorChunkWidth = Math.ceil(chunkWidth / collectorWorldScale);
				const collectorChunkHeight = Math.ceil(chunkHeight / collectorWorldScale);
				if (chunkWidth <= 0 || chunkHeight <= 0) continue;
				// FOG-SKIP (include optimization): chunk ALLKOWICIE undiscovered (shadow=255 everywhere)
				// it is black at the customer's - we do not ship. After discovering, the shadow changes → chunk dirty → it will fly.
				// (initial fill: out of 9216 chunks, only the uncovered part of the map is actually filled - joining 2-4x faster)
				if (shadow) {
					let fogged = true;
					for (let r = 0; r < chunkHeight && fogged; r++) {
						const src = (startY + r) * worldWidth + startX;
						for (let c = 0; c < chunkWidth; c++) if (shadow[src + c] !== 255) { fogged = false; break; }
					}
					if (fogged) { fogSkipped++; continue; }
				}
				// ROW-DELTA v5: hash per WIERSZ (12*chunkWidth bytes over 6 layers); we only send changed lines.
				// Poziomy traffic (water in the channel, tapes) = 1-3 lines instead of the whole 40 → 2-10x less bandwidth.
				// Memory cost: 9,216 chunks × 40 rows × 4 bytes is about 1.5 MB. A full resend clears `rowH`.
				if (!worldSync.rowH) worldSync.rowH = new Map();
				let rowHashes = worldSync.rowH.get(chunkIndex);
				if (!rowHashes || rowHashes.length < chunkHeight) { rowHashes = new Uint32Array(CHUNK); rowHashes.fill(0); worldSync.rowH.set(chunkIndex, rowHashes); }
				const elementTypeRows = new Uint8Array(chunkWidth * chunkHeight); // warstwa typu elementu liczona raz (hash + zapis)
				if (cellIdArray && elementTypes) {
					for (let r = 0; r < chunkHeight; r++) for (let cc = 0; cc < chunkWidth; cc++) {
						const cid = cellIdArray[(startY + r) * worldWidth + startX + cc];
						elementTypeRows[r * chunkWidth + cc] = (cid >= ELEMENTS_MIN && cid <= ELEMENTS_MAX) ? (elementTypes[cid - ELEMENTS_MIN] || 0) & 0xff : 0;
					}
				}
				const hashRow = (r) => {
					let h = 0x811c9dc5;
					const m0 = ((startY + r) * worldWidth + startX) * 4, s0 = (startY + r) * worldWidth + startX;
					for (let i = 0; i < chunkWidth * 4; i++) { h ^= map[m0 + i]; h = (h * 0x01000193) >>> 0; }
					for (let i = 0; i < chunkWidth; i++) { h ^= wall[s0 + i]; h = (h * 0x01000193) >>> 0; }
					if (shadow) for (let i = 0; i < chunkWidth; i++) { h ^= shadow[s0 + i]; h = (h * 0x01000193) >>> 0; }
					if (authorization) for (let i = 0; i < chunkWidth; i++) { h ^= authorization[s0 + i]; h = (h * 0x01000193) >>> 0; }
					if (cellIds) { const sb = new Uint8Array(cellIds.buffer, cellIds.byteOffset + s0 * 4, chunkWidth * 4); for (let i = 0; i < chunkWidth * 4; i++) { h ^= sb[i]; h = (h * 0x01000193) >>> 0; } }
					for (let i = 0; i < chunkWidth; i++) { h ^= elementTypeRows[r * chunkWidth + i]; h = (h * 0x01000193) >>> 0; }
					// collectorGoldCount is a 4x4-world-cell block grid. Fold one collector
					// row into each corresponding world-row hash so occupancy-only changes ship.
					if (collectorGoldCount && r % collectorWorldScale === 0) {
						const collectorStartX = startX / collectorWorldScale;
						const collectorY = (startY + r) / collectorWorldScale;
						const collectorOffset = collectorY * collectorWidth + collectorStartX;
						for (let i = 0; i < collectorChunkWidth; i++) { h ^= collectorGoldCount[collectorOffset + i]; h = (h * 0x01000193) >>> 0; }
					}
					return h === 0 ? 1 : h; // 0 reserved = "never sent"
				};
				const mask = new Uint8Array(5); // 40 bits
				const rows = [];
				for (let r = 0; r < chunkHeight; r++) {
					const h = hashRow(r);
					if (rowHashes[r] !== h) { rowHashes[r] = h; mask[r >> 3] |= 1 << (r & 7); rows.push(r); }
				}
				if (!rows.length) continue; // nothing has changed in chunk
				const collectorByteCount = collectorGoldCount ? collectorChunkWidth * collectorChunkHeight : 0;
				const serializedChunk = new Uint8Array(11 + rows.length * chunkWidth * 12 + collectorByteCount);
				const dataView = new DataView(serializedChunk.buffer);
				dataView.setUint16(0, chunkX, true); dataView.setUint16(2, chunkY, true);
				serializedChunk[4] = chunkWidth; serializedChunk[5] = chunkHeight;
				serializedChunk.set(mask, 6);
				let o = 11;
				for (const r of rows) { const src = ((startY + r) * worldWidth + startX) * 4; serializedChunk.set(map.subarray(src, src + chunkWidth * 4), o); o += chunkWidth * 4; }
				for (const r of rows) { const src = (startY + r) * worldWidth + startX; serializedChunk.set(wall.subarray(src, src + chunkWidth), o); o += chunkWidth; }
				for (const r of rows) { const src = (startY + r) * worldWidth + startX; if (shadow) serializedChunk.set(shadow.subarray(src, src + chunkWidth), o); o += chunkWidth; }
				for (const r of rows) { const src = (startY + r) * worldWidth + startX; if (authorization) serializedChunk.set(authorization.subarray(src, src + chunkWidth), o); o += chunkWidth; }
				for (const r of rows) { const src = (startY + r) * worldWidth + startX; if (cellIds) serializedChunk.set(new Uint8Array(cellIds.buffer, cellIds.byteOffset + src * 4, chunkWidth * 4), o); o += chunkWidth * 4; }
				for (const r of rows) { serializedChunk.set(elementTypeRows.subarray(r * chunkWidth, r * chunkWidth + chunkWidth), o); o += chunkWidth; }
				if (collectorGoldCount) {
					const collectorStartX = startX / collectorWorldScale, collectorStartY = startY / collectorWorldScale;
					for (let r = 0; r < collectorChunkHeight; r++) {
						const src = (collectorStartY + r) * collectorWidth + collectorStartX;
						serializedChunk.set(collectorGoldCount.subarray(src, src + collectorChunkWidth), o);
						o += collectorChunkWidth;
					}
				}
				serializedChunks.push(serializedChunk); serializedChunkIndexes.push(chunkIndex); size += serializedChunk.length;
			}
			if (!serializedChunks.length) { worldSync.busy = false; return; }
			const uncompressedBatch = new Uint8Array(size);
			let o = 0; for (const p of serializedChunks) { uncompressedBatch.set(p, o); o += p.length; }
			const compressedBatch = await deflate(uncompressedBatch);
			worldSync.seq++; // batch number the client echoes back in wcack
			let probe = null;
			if (worldSync.seq % DET_PROBE_INTERVAL === 0) {
				probe = [];
				const expected = new Map();
				for (const chunkIndex of serializedChunkIndexes) { const h = hashWorldChunk(state, chunkIndex); probe.push(chunkIndex); expected.set(chunkIndex, h); }
				sandustryMP.det.probeSent.set(worldSync.seq, expected);
				for (const sq of [...sandustryMP.det.probeSent.keys()]) if (sq < worldSync.seq - 100) sandustryMP.det.probeSent.delete(sq);
			}
			// q = host queue size (client progress countdown, 0.9.62) + sq = pack number (wcack, PR #8)
			const decisionClock = decisionClockSnapshot();
			net.send({ t: "wc", v: 6, sq: worldSync.seq, ep: sandustryMP.det.hostEpoch, ct: decisionClock.tick, cs: decisionClock.seed, cb: decisionClock.base, ph: probe, wid: state.store.meta && state.store.meta.worldId, scene: state.store.scene && state.store.scene.active, W: worldWidth, H: worldHeight, n: serializedChunks.length, q: worldSync.pending.size, d: encodeBase64(compressedBatch) });
			// EMA of what a chunk really costs on the wire, drives the batch budget above. Cheap chunks
			// (few changed rows) earn a bigger portion, expensive ones a smaller one, so the byte ceiling
			// holds regardless of what the simulation is doing.
			const bpcNow = compressedBatch.length / serializedChunks.length;
			worldSync.bpc = worldSync.bpc ? worldSync.bpc * 0.8 + bpcNow * 0.2 : bpcNow;
			// statystyki
			worldSync.applyBytes += compressedBatch.length; worldSync.applyCount += serializedChunks.length;
			worldSync.fogSkipped = (worldSync.fogSkipped || 0) + fogSkipped;
			if (now - worldSync.statT > 2000) {
				// lag and rate appended raw, no i18n: this is a diagnostic readout, not player facing text.
				// Blank when no client acks, so an un-throttled session does not show a misleading zero.
				const cc = worldSync.ackSeen ? "  lag " + worldSync.lag + " (" + Math.round(worldSync.rate * 100) + "%)" : "";
				const info = t("sync_up", Math.round(worldSync.applyBytes / 2048), Math.round(worldSync.applyCount / 2), worldSync.pending.size) + cc;
				setSyncInfo(info);
				log("SYNC-HOST", info, worldSync.fogSkipped ? "(fog-skip: " + worldSync.fogSkipped + ")" : "");
				worldSync.applyBytes = 0; worldSync.applyCount = 0; worldSync.statT = now; worldSync.fogSkipped = 0;
			}
		} catch (e) { log("batch error:", e.message); }
		worldSync.busy = false;
	}

	// ------------------------------------------------------------------
	// World synchronization: client batch application and simulation pause
	// ------------------------------------------------------------------
	function setClientPaused(paused) {
		if (!sandustryMP.state || sandustryMP.wsx.paused === paused) return;
		const mgr = managerWorker(sandustryMP.state);
		if (!mgr) { log("ERROR: no manager worker for pause"); return; }
		mgr.postMessage([54, paused]); // SetPaused - manager only; session.paused becomes false => render works
		sandustryMP.wsx.paused = paused;
		log("Client simulation:", paused ? "PAUSED (host mirror)" : "resumed");
	}

	async function applyWorldBatch(msg) {
		if (sandustryMP.net.role !== "client" || !sandustryMP.state) return;
		const state = sandustryMP.state;
		const myWid = state.store.meta && state.store.meta.worldId;
		const myScene = state.store.scene && state.store.scene.active;
		// The former test mode painted while both players were in the menu. It was removed to fix instant disconnects.
		// painted host menu-buffers after client menu and set everApplied in menu → auto-exit
		// It immediately disconnected new players. The mirror must never write while the client is in the menu.
		const menuTest = false;
		// Client in menu (fix: "main menu turns into red blocks"): the host mirror must not
		// paint across the menu scene - world data landed in the menu scene buffers as red tiles.
		if (myScene === 1) return;
		// World load in progress (TCentraL, "big map freeze"): writing to world buffers
		// in TRAKCIE FH.game.load = race with the save loading engine (crashing/corruption).
		// Dropujemy - AUTO-RESYNC will still send the full world after the mirror starts.
		if (sandustryMP._loadingWorld) return;
		if (msg.wid && myWid && msg.wid !== myWid && !menuTest) {
			// Zaufanie: engine gives the loaded INNY world a local worldId than the host uses in "wc", even though this
			// exactly the same save. Rejecting it caused reconciliation to delete client structures.
			// Ufamy when: (a) already trusted, (b) window after auto-load, LUB (c) we got the world FROM this host (world-begin)
			// and OBOJE we are in the game (scene≠1) - that is, the client has actually loaded the host save (auto- or manually).
			const bothInWorld = msg.scene !== 1 && myScene !== 1;
			// ZAUFANIE SPAROWANE (fix tones: "loading another world adds it as red blocks"):
			// Trust binds the host world ID to the client world ID at the moment trust is established.
			// Loading another world changes the pair, so reject the mirror instead of painting over an unrelated save.
			// _gotHostWorld is JEDNORAZOWE (consumed on first accept).
			const trusting = (sandustryMP._trustedWid === msg.wid && sandustryMP._trustedMyWid === myWid)
				|| (sandustryMP._pendingTrustUntil && performance.now() < sandustryMP._pendingTrustUntil)
				|| (sandustryMP._gotHostWorld && bothInWorld)
				|| (sandustryMP._lastGoodWid === msg.wid && sandustryMP._lastGoodMyWid === myWid && bothInWorld);
			if (!trusting) {
				setStatus(t("other_world"), "#f66");
				if (!sandustryMP.wsx.mismatchLogged) { sandustryMP.wsx.mismatchLogged = true; log("REJECT world: worldId host=" + msg.wid + " me=" + myWid + " scene h/c=" + msg.scene + "/" + myScene); }
				return;
			}
			if (sandustryMP._trustedWid !== msg.wid) log("worldId differs after auto-load, but I trust (freshly received from the host):", msg.wid);
			sandustryMP._trustedWid = msg.wid; sandustryMP._trustedMyWid = myWid; sandustryMP._pendingTrustUntil = 0;
			sandustryMP._gotHostWorld = false; // one-off - from now on, pair rules (hostWid, myWid)
			sandustryMP._lastGoodWid = msg.wid; sandustryMP._lastGoodMyWid = myWid; // Preserve the trusted pair across reconnects intentionally.
		}
		const { map, wall, shadow, collectorGoldCount, width: worldWidth, height: worldHeight } = worldBuffers(state);
		if (!map || worldWidth !== msg.W || worldHeight !== msg.H) {
			setStatus(t("dims_differ", worldWidth + "x" + worldHeight, msg.W + "x" + msg.H), "#f66");
			if (!sandustryMP.wsx.mismatchLogged) { sandustryMP.wsx.mismatchLogged = true; log("REJECT world: dims host=" + msg.W + "x" + msg.H + " me=" + worldWidth + "x" + worldHeight + " map=" + (!!map)); }
			return;
		}
		if (msg.v !== 6) { setStatus(t("ver_mismatch"), "#f66"); return; } // v6 = row-delta plus collector occupancy grid
		if (sandustryMP.wsx.mismatchLogged) { sandustryMP.wsx.mismatchLogged = false; log("World match confirmed; the mirror is starting"); }
		sandustryMP.wsx.mismatchWarned = false;
		setClientPaused(true);
		const { authorization, cellIds, elementTypes } = worldBuffers(state);
		const cellIdArray = cellIds ? new Uint32Array(cellIds.buffer, cellIds.byteOffset, worldWidth * worldHeight) : null;
		const decompressedBatch = await inflate(decodeBase64(msg.d));
		const dataView = new DataView(decompressedBatch.buffer);
		let readOffset = 0, appliedChunkCount = 0;
		while (readOffset + 6 <= decompressedBatch.length) {
			const chunkX = dataView.getUint16(readOffset, true), chunkY = dataView.getUint16(readOffset + 2, true);
			const chunkWidth = decompressedBatch[readOffset + 4], chunkHeight = decompressedBatch[readOffset + 5];
			// v5 row delta: a five-byte row mask identifies the only changed rows present in the stream.
			if (readOffset + 11 > decompressedBatch.length) break;
			const rowMask = decompressedBatch.subarray(readOffset + 6, readOffset + 11);
			readOffset += 11;
			const startX = chunkX * CHUNK, startY = chunkY * CHUNK;
			const changedRows = [];
			for (let r = 0; r < chunkHeight; r++) if (rowMask[r >> 3] & (1 << (r & 7))) changedRows.push(r);
			const collectorWorldScale = 4;
			const collectorChunkWidth = Math.ceil(chunkWidth / collectorWorldScale), collectorChunkHeight = Math.ceil(chunkHeight / collectorWorldScale);
			const collectorByteCount = collectorGoldCount ? collectorChunkWidth * collectorChunkHeight : 0;
			if (readOffset + changedRows.length * chunkWidth * 12 + collectorByteCount > decompressedBatch.length) break; // corrupt batch
			for (const r of changedRows) { const destinationOffset = ((startY + r) * worldWidth + startX) * 4; map.set(decompressedBatch.subarray(readOffset, readOffset + chunkWidth * 4), destinationOffset); readOffset += chunkWidth * 4; }
			for (const r of changedRows) { const destinationOffset = (startY + r) * worldWidth + startX; wall.set(decompressedBatch.subarray(readOffset, readOffset + chunkWidth), destinationOffset); readOffset += chunkWidth; }
			for (const r of changedRows) { const destinationOffset = (startY + r) * worldWidth + startX; if (shadow) shadow.set(decompressedBatch.subarray(readOffset, readOffset + chunkWidth), destinationOffset); readOffset += chunkWidth; }
			for (const r of changedRows) { const destinationOffset = (startY + r) * worldWidth + startX; if (authorization) authorization.set(decompressedBatch.subarray(readOffset, readOffset + chunkWidth), destinationOffset); readOffset += chunkWidth; }
			for (const r of changedRows) { const destinationOffset = (startY + r) * worldWidth + startX; if (cellIds) new Uint8Array(cellIds.buffer, cellIds.byteOffset + destinationOffset * 4, chunkWidth * 4).set(decompressedBatch.subarray(readOffset, readOffset + chunkWidth * 4)); readOffset += chunkWidth * 4; }
			// element type layer: type into elementData.type[cellId-MIN] for getResolvedTypeFromCellId to work (grabber)
			for (const r of changedRows) { for (let cc = 0; cc < chunkWidth; cc++) { const ty = decompressedBatch[readOffset++]; if (elementTypes && cellIdArray) { const cid = cellIdArray[(startY + r) * worldWidth + startX + cc]; if (cid >= ELEMENTS_MIN && cid <= ELEMENTS_MAX) elementTypes[cid - ELEMENTS_MIN] = ty; } } }
			if (collectorGoldCount) {
				const collectorWidth = Math.ceil(worldWidth / collectorWorldScale);
				const collectorStartX = startX / collectorWorldScale, collectorStartY = startY / collectorWorldScale;
				for (let r = 0; r < collectorChunkHeight; r++) {
					const destinationOffset = (collectorStartY + r) * collectorWidth + collectorStartX;
					collectorGoldCount.set(decompressedBatch.subarray(readOffset, readOffset + collectorChunkWidth), destinationOffset);
					readOffset += collectorChunkWidth;
				}
			}
			appliedChunkCount++;
		}
		// Ochrona grabber: mirror may have retrieved STARA cell contents (host has not yet processed
		// our grabPick/grabPlace). PICK: hold 0 until host confirms deletion. PLACE: hold sentinel
		// until the host confirms the non-zero content. Grace ping adaptive (grabGraceMs).
		if (cellIds && (sandustryMP._grabbedCells.size || sandustryMP._placedCells.size)) {
			const tNow = performance.now(), grace = grabGraceMs();
			const cellIdArray = new Uint32Array(cellIds.buffer, cellIds.byteOffset, worldWidth * worldHeight);
			for (const [cellIndex, grabbedCell] of sandustryMP._grabbedCells) {
				if (tNow - grabbedCell.ts > grace) { sandustryMP._grabbedCells.delete(cellIndex); continue; } // the host had time - give up control
				const v = cellIdArray[cellIndex];
				// FIX "2-3 puis stop": relative
				// If a new element falls into the grabbed cell, release the guard so it can be grabbed. Previously this forced zero blindly.
				// (v!==0 → 0) for 1200ms → the collapsing heap was hidden → impossible to grab the rest.
				if (v !== 0 && v !== grabbedCell.cid) sandustryMP._grabbedCells.delete(cellIndex); // new element dropped → give back (grabbable)
				else cellIdArray[cellIndex] = 0; // still old element or empty → keep empty (anti-duplicate)
			}
			for (const [cellIndex, ts] of sandustryMP._placedCells) {
				if (tNow - ts > grace) { if ((sandustryMP._grabDiag2 = (sandustryMP._grabDiag2 || 0) + 1) <= 60) log("GRAB place TIMEOUT @cellIndex", cellIndex, "after", Math.round(tNow - ts), "ms - mirror never confirmed the item (fallen/lost?), cellId lustra=" + cellIdArray[cellIndex]); sandustryMP._placedCells.delete(cellIndex); continue; }
				// Re-grab fix: release only after a real element ID arrives. Previously any nonzero sentinel released the guard.
				// released on our PROPRE sentinel (=1) → the cell remained at 1 (not grabbable) → re-grab impossible.
				if (cellIdArray[cellIndex] >= ELEMENTS_MIN && cellIdArray[cellIndex] <= ELEMENTS_MAX) { if ((sandustryMP._grabDiag2 = (sandustryMP._grabDiag2 || 0) + 1) <= 60) log("GRAB placement confirmed @cellIndex", cellIndex, "after", Math.round(tNow - ts), "ms, cellId=" + cellIdArray[cellIndex], "-> re-grab enabled"); sandustryMP._placedCells.delete(cellIndex); }
				else cellIdArray[cellIndex] = GRAB_SENTINEL; // no real element yet (0 or sentinel) → “occupied” guard
			}
		}
		const worldSync = sandustryMP.wsx;
		if (appliedChunkCount > 0) sandustryMP._lastWcT = performance.now(); // to congestion indicator (sync_stalled)
		// Record the batch AFTER applying it, not on receipt, so the host's lag also catches a client that
		// is CPU bound, not only a saturated link.
		if (typeof msg.sq === "number") sandustryMP._lastAppliedSq = msg.sq;
		if (typeof msg.ep === "number") sandustryMP.det.remoteEpoch = msg.ep;
		acceptRemoteDecisionClock(msg);
		if (Array.isArray(msg.ph) && msg.ph.length) {
			const hashes = [];
			for (const chunkIndex of msg.ph) hashes.push([chunkIndex, hashWorldChunk(state, chunkIndex)]);
			try { net.send({ t: "dprobe", sq: msg.sq, ep: msg.ep, ct: msg.ct, h: hashes }); } catch (e) {}
		}
		if (appliedChunkCount > 0 && !worldSync.everApplied) {
			worldSync.everApplied = true; log("First world packages applied - mirror works"); setStatus(t("players", sandustryMP.peers.size + 1));
			profileRestore(state, msg.wid || sandustryMP._trustedWid); // go back where you left off in TYM world (G7-lite)
			// AUTO-RESYNC (fix TCentraL "big map"): initial flood (enqueueFullWorld via peer-hello) was running
			// when the client was still in MENU/load and was DROPOWANY and the host's rowH considers it delivered
			// → without it there are constantly holes in the world until the manual Resync. Raz per session (_autoResynced flag).
			if (!sandustryMP._autoResynced) { sandustryMP._autoResynced = true; try { net.send({ t: "resync" }); log("AUTO-RESYNC: asking the host for a full world (packs from before entering the world were dropped)"); } catch (e) {} }
		}
		worldSync.applyBytes += msg.d.length * 0.75; worldSync.applyCount += appliedChunkCount;
		const now = performance.now();
		if (now - worldSync.statT > 2000) {
			// q = how many packages are left in the host's queue - a real indicator of the progress of the initial synchronization
			// large map (feedback TCentraL: "no real progress to when it loads")
			const info = t("sync_down", Math.round(worldSync.applyBytes / 2048), Math.round(worldSync.applyCount / 2), typeof msg.q === "number" ? msg.q : 0);
			setSyncInfo(info);
			log("SYNC-CLIENT", info);
			worldSync.applyBytes = 0; worldSync.applyCount = 0; worldSync.statT = now;
		}
	}

	// ------------------------------------------------------------------
	// STRUKTURY — replikacja event-driven + okresowe uzgadnianie (snapshot)
	// ------------------------------------------------------------------
	// `queued` is Sandustry's native representation of a partially blocked build.
	// It must cross the network or clients reconstruct conveyors over sand as fully
	// completed structures. `frame` is paired native foundation state.
	const slimStruct = (s) => ({ type: s.type, x: s.x, y: s.y, data: s.data, filter: s.filter, queued: s.queued === true, frame: s.frame === true });
	const structKey = (s) => s.type + "@" + s.x + "," + s.y;
	// KONFIG MASZYN by client (G5b): structure.data editions in the machine UI do not have an event - we detect
	// It diffs JSON near the player, where edits occur; scanning thousands of structures every frame is too expensive.
	const dataSeenSet = (k, d) => { if (!sandustryMP._dataSeen) sandustryMP._dataSeen = new Map(); try { sandustryMP._dataSeen.set(k, JSON.stringify(d == null ? null : d)); } catch (e) {} };
	function scanDataEditsIfDue(state) {
		const now = performance.now();
		if (now - (sandustryMP._dataScanT || 0) < 800) return;
		sandustryMP._dataScanT = now;
		try {
			if (!sandustryMP._dataSeen) return;
			if (!sandustryMP._dataEdited) sandustryMP._dataEdited = new Map();
			const px = state.store.player.x / 4, py = state.store.player.y / 4, R = 48; // ~screen around the player (cell)
			for (const s of state.store.structures || []) {
				if (Math.abs(s.x - px) > R || Math.abs(s.y - py) > R) continue;
				const k = structKey(s);
				const prev = sandustryMP._dataSeen.get(k);
				if (prev === undefined) { dataSeenSet(k, s.data); continue; }
				let cur; try { cur = JSON.stringify(s.data == null ? null : s.data); } catch (e) { continue; }
				if (cur !== prev) {
					sandustryMP._dataSeen.set(k, cur);
					sandustryMP._dataEdited.set(k, now);
					try { net.send({ t: "act", k: "sdata", x: s.x, y: s.y, type: s.type, data: JSON.parse(cur) }); } catch (e) {}
					log("CLIENT machine config →", k);
				}
			}
			// higiena okna ochronnego
			for (const [k, ts] of sandustryMP._dataEdited) if (now - ts > 10000) sandustryMP._dataEdited.delete(k);
		} catch (e) {}
	}

	function subscribeGameEvents(state) {
		if (sandustryMP._subscribedState === state || !sandustryMP.gameApi || !sandustryMP.gameApi.events) return;
		sandustryMP._subscribedState = state;
		try {
			repairUnlockedResearch(state);
			// Client placement is captured by the `_place` bundle patch, required since the 2026-08-17 game update.
			// "building:place" to formalny INTERCEPTOR (FH.hooks.intercept + ctrl.cancel() + {structureTypes}),
			// This is not a cancelable event, so the old event subscription could not intercept it.
			// = the customer could not stake NICZEGO. Patch _place takes the intent at the source (see sandustryMP._place).
			sandustryMP.gameApi.events.on(state, "structures:placed", (st, data) => {
				// only HOST broadcasts its own settings; client no longer (cancels before saving)
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "host") return;
				const list = ((data && data.structures) || []).map(slimStruct);
				if (list.length) net.send({ t: "st", k: "add", list });
			});
			sandustryMP.gameApi.events.on(state, "structures:removed", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role === "idle") return;
				const list = ((data && data.removed) || []).map((s) => ({ type: s.type, x: s.x, y: s.y }));
				if (!list.length) return;
				if (data && data.byMove) { sandustryMP._moveStash = list; return; } // old items - waiting for structures:moved
				if (sandustryMP.net.role === "host") net.send({ t: "st", k: "rm", list });
				else net.send({ t: "act", k: "demolish", list });
			});
			sandustryMP.gameApi.events.on(state, "structures:moved", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role === "idle") return;
				const to = ((data && data.moved) || []).map(slimStruct);
				const from = sandustryMP._moveStash; sandustryMP._moveStash = [];
				if (!to.length || !from.length) return;
				if (sandustryMP.net.role === "host") net.send({ t: "st", k: "mv", from, to });
				else net.send({ t: "act", k: "move", from, to });
			});
			sandustryMP.gameApi.events.on(state, "worldItem:pickedUp", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.item) return;
				sandustryMP._pickedPending.set(data.item.id, performance.now());
				net.send({ t: "act", k: "pickup", id: data.item.id });
			});
			// Grabber/grabber: client forwards item pick/put → host executes authoritatively
			// through `FH.elements.removeAt/createAt` without another bundle patch. Fixes "grabber does not take wet sand". Contributed by dotNine.
			sandustryMP.gameApi.events.on(state, "grabber:elementPickedUp", (st, data) => {
				// DIAG unconditional: does the pick fire on the client side, with what elementType?
				if ((sandustryMP._pickDiag = (sandustryMP._pickDiag || 0) + 1) <= 80) log("GRAB pickEvent fired: role=" + sandustryMP.net.role, "et=" + (data && data.elementType), "@", data && data.x, data && data.y, "applyingNet=" + sandustryMP._applyingNet);
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data) return;
				if (!validElement(data.elementType)) { if ((sandustryMP._pickDiag3 = (sandustryMP._pickDiag3 || 0) + 1) <= 20) log("GRAB pick rejected: invalid elementType =", data.elementType); return; }
				net.send({ t: "act", k: "grabPick", x: data.x, y: data.y, et: data.elementType });
				// KLUCZ: we delete the cell locally FROM RAZU. Zapis grabber to the world goes by deferred
				// The `Lu` queue does not execute while the client is paused, so the cell remains locally and the grabber
				// takes it again every frame until the host mirror removes it roughly 100 ms later.
				// Set `cellId=0`; the grabber then sees an empty cell and does not take the same element again.
				// Host removes authoritatively and confirms with a mirror. _grabbedCells protects against rollback.
				grabClearLocal(state, data.x, data.y);
			});
			sandustryMP.gameApi.events.on(state, "grabber:elementPlaced", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data) return;
				// Reject placement from an empty or out-of-bounds tank slot (`T[o+2]` is undefined during client desync):
				// elementType == null/0 → JSON gubi pole → host createAt(...,undefined) = crash "reading 'type'"
				// Invalid slots caused repeated "item lost" messages. Forward only real element types.
				if (!validElement(data.elementType)) return;
				net.send({ t: "act", k: "grabPlace", x: data.x, y: data.y, et: data.elementType });
				grabSetLocal(state, data.x, data.y); // block re-targeting this cell (see comment at grabSetLocal)
			});
			// Upgrades and the technology tree use a shared-pool model: one factory means shared unlocks.
			// A client purchase mutates its local store and initially subtracts resources only locally; the host snapshot follows.
			// would overwrite it = free purchase and invisible to the host - G2 vulnerability). Forward: we count the cost
			// from the difference in resources vs the last snapshot of the host (the event fires JUST after the subtraction).
			const resCostDiff = () => {
				const cost = {};
				try {
					const cur = state.store.resources || {};
					const base = sandustryMP._resSnapshot || {};
					for (const k of Object.keys(base)) {
						const b = base[k], c = cur[k];
						if (typeof b === "number" && typeof c === "number" && c < b) cost[k] = b - c;
					}
					sandustryMP._resSnapshot = Object.assign({}, cur); // re-base (several purchases in <1s count correctly)
				} catch (e) {}
				return cost;
			};
			sandustryMP.gameApi.events.on(state, "upgrade:purchased", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data) return;
				net.send({ t: "act", k: "upg", it: data.itemId, ug: data.upgradeId, lv: data.level, cost: resCostDiff() });
				log("CLIENT upgrade →", data.itemId + "." + data.upgradeId, "lvl", data.level);
			});
			// Technologies already present when this state was attached have already run their local unlock side effects.
			const initiallyAppliedTech = techSideEffectsFor(state);
			const initialTech = state.store.player && state.store.player.tech;
			if (initialTech) for (const techId of Object.keys(initialTech)) if (initialTech[techId]) {
				const key = canonicalTechKey(techId);
				if (key) initiallyAppliedTech.add(key);
			}
			sandustryMP.gameApi.events.on(state, "tech:unlocked", (st, data) => {
				if (!data || data.techId == null) return;
				persistResearchLedger(state);
				const key = canonicalTechKey(data.techId);
				if (!key) return;
				if (!sandustryMP._applyingNet) techSideEffectsFor(state).add(key);
				if (sandustryMP._applyingNet || !sandustryMP.wsx.paused) return;
				if (sandustryMP.net.role === "client") {
					net.send({ t: "act", k: "tech", id: data.techId, cost: resCostDiff() });
					log("CLIENT tech →", data.techId);
				} else if (sandustryMP.net.role === "host") {
					net.send({ t: "tech", id: data.techId });
					log("HOST tech → all clients", data.techId);
				}
			});
			sandustryMP.gameApi.events.on(state, "store:save", () => persistResearchLedger(state));
			sandustryMP.gameApi.events.on(state, "factory:levelUp", (st, data) => {
				if (sandustryMP._applyingNet || !sandustryMP.wsx.paused || !data || !Number.isInteger(data.newLevel)) return;
				if (sandustryMP.net.role === "client") {
					net.send({ t: "act", k: "tier" });
					log("CLIENT factory tier unlock requested; local level", data.newLevel);
				} else if (sandustryMP.net.role === "host") {
					net.send({ t: "tier", level: data.newLevel });
					log("HOST factory tier unlocked ->", data.newLevel);
				}
			});
			// Story progression (fix G6): a step triggered by a client item or action initially mutates only local storage.
			// (storyProgression.completedSteps) and after 1 second the host overwrote it. Forward → host adds a step.
			sandustryMP.gameApi.events.on(state, "story:stepCompleted", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.stepId) return;
				net.send({ t: "act", k: "story", id: data.stepId });
				log("CLIENT story step →", data.stepId);
			});
			// KOLEKCJE critters (fix G6): found/available/tickets live in store.creatures/conservatory,
			// overwritten by the host - the client file rolled back in 100ms. Forward → host charges.
			sandustryMP.gameApi.events.on(state, "entity:collected", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.typeId) return;
				net.send({ t: "act", k: "collect", ty: data.typeId, eid: data.entityId });
				log("CLIENT collect →", data.typeId, "(id " + data.entityId + ")");
			});
			// Signal links (G5): client link/unlink mutates local signal storage that the host snapshot would overwrite.
			// client automation disappeared after 1 second. Forward changes → host executes FH.signals.link/unlink.
			sandustryMP.gameApi.events.on(state, "signals:userChanged", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.changes) return;
				const ch = data.changes.map((c) => ({ a: c.action, f: c.from && { x: c.from.x, y: c.from.y }, t: c.to && { x: c.to.x, y: c.to.y } })).filter((c) => c.a && c.f && c.t);
				if (ch.length) { net.send({ t: "act", k: "sig", ch }); log("CLIENT signals →", ch.length, "changes"); }
			});
			// signal button: toggle status by client
			sandustryMP.gameApi.events.on(state, "signalButton:pressed", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.structure) return;
				const s = data.structure;
				net.send({ t: "act", k: "sbtn", x: s.x, y: s.y, on: !!(s.data && s.data.on) });
			});
			// COPY-PASTE blueprints (G5 fix): pasted client structures were local → reconcile deleted them
			sandustryMP.gameApi.events.on(state, "structures:pasted", (st, data) => {
				if (sandustryMP._applyingNet || sandustryMP.net.role !== "client" || !sandustryMP.wsx.paused || !data || !data.structures) return;
				const list = data.structures.map(slimStruct);
				let links = null;
				try { if (data.signalLinks) links = JSON.parse(JSON.stringify(data.signalLinks)); } catch (e) {}
				if (list.length) { net.send({ t: "act", k: "paste", list, links }); log("CLIENT paste →", list.length, "structures"); }
			});
			log("Structure/item event subscriptions active");
		} catch (e) { log("subscribe error:", e.message); }
	}

	// Update games 2026-08-17 renamed/moved FH.structures (disappeared from top-level FH).
	// Resolver: find namespace with build+removeAt wherever it is (top-level or 1 level deeper).
	function structNs() {
		if (sandustryMP._structNs && typeof sandustryMP._structNs.build === "function") return sandustryMP._structNs;
		const gameApi = sandustryMP.gameApi; if (!gameApi) return null;
		const isIt = (v) => v && typeof v === "object" && typeof v.build === "function" && typeof v.removeAt === "function" && typeof v.getAtCell === "function";
		if (isIt(gameApi.structures)) { sandustryMP._structNs = gameApi.structures; return sandustryMP._structNs; }
		for (const key of Object.keys(gameApi)) { try { if (isIt(gameApi[key])) { sandustryMP._structNs = gameApi[key]; log("structures API under gameApi." + key); return sandustryMP._structNs; } } catch (e) {} }
		for (const key of Object.keys(gameApi)) {
			try {
				const namespace = gameApi[key]; if (!namespace || typeof namespace !== "object") continue;
				for (const nestedKey of Object.keys(namespace)) { if (isIt(namespace[nestedKey])) { sandustryMP._structNs = namespace[nestedKey]; log("structures API under gameApi." + key + "." + nestedKey); return sandustryMP._structNs; } }
			} catch (e) {}
		}
		if (!sandustryMP._structNsWarned) { sandustryMP._structNsWarned = true; log("ERROR: did not find structures API (build/removeAt/getAtCell):", Object.keys(gameApi).join(",")); }
		return null;
	}
	// force=true is reserved for rendering structures already confirmed by the host on paused clients.
	// It skips collision checks by explicitly specifying clearance = Available. IMPORTANT (0.5.4): former
	// The old `clearance:-1` workaround wrote an invalid J6 enum value into structures, causing the game to treat them as
	// Distinguish damaged or blocked placement from a successful placement that was immediately removed. `Available=1`, while blocked is 2 or 3.
	// passes checks (≠FullyBlocked/≠PartiallyBlocked) and the structure is POPRAWNA → does not disappear.
	const CLEARANCE_AVAILABLE = 1; // J6.Available w buildzie 0.5.4 (patrz enum: Available=1,FullyBlocked=2,PartiallyBlocked=3,CanBeReplaced=4)
	const CLEARANCE_PARTIALLY_BLOCKED = 3;
	function buildOne(state, s, force) {
		try {
			const SA = structNs(); if (!SA) return null;
			const existing = SA.getAtCell(state, s.x, s.y);
			// Idempotent reconciliation is only for structures the host already confirmed.
			// New host-side placement requests must reach native validation even when an
			// identical structure currently occupies the requested cell.
			if (force && existing && existing.type === s.type) {
				let nativeStateChanged = false;
				if (Object.prototype.hasOwnProperty.call(s, "queued")) {
					const queued = s.queued === true ? true : undefined;
					if (existing.queued !== queued) { existing.queued = queued; nativeStateChanged = true; }
				}
				if (Object.prototype.hasOwnProperty.call(s, "frame")) {
					const frame = s.frame === true ? true : undefined;
					if (existing.frame !== frame) { existing.frame = frame; nativeStateChanged = true; }
				}
				if (s.data && JSON.stringify(existing.data) !== JSON.stringify(s.data)) {
					// KONFIG MASZYN (G5b): data freshly edited by the client is protected against overwriting
					// via host snapshot (act sdata is on its way; host will confirm in next snap)
					const k = structKey(s);
					const edited = sandustryMP._dataEdited && sandustryMP._dataEdited.get(k);
					if (!(sandustryMP.net.role === "client" && edited != null && performance.now() - edited < 6000)) {
						existing.data = s.data;
						if (SA.update) SA.update(state, existing, { propagateToWorkers: sandustryMP.net.role === "host" });
						if (sandustryMP.net.role === "client") dataSeenSet(k, s.data); // client edit detection database
					}
				} else if (sandustryMP.net.role === "client") dataSeenSet(structKey(s), existing.data);
				if (s.filter !== undefined && JSON.stringify(existing.filter) !== JSON.stringify(s.filter)) {
					existing.filter = JSON.parse(JSON.stringify(s.filter));
					nativeStateChanged = true;
				}
				if (nativeStateChanged && SA.update) SA.update(state, existing, { propagateToWorkers: sandustryMP.net.role === "host" });
				return existing;
			}
			// Reconstruct host-confirmed partial builds through the native partial-clearance
			// branch. This adds them to Sandustry's own queued-structure list, allowing the
			// structure to finish naturally after the obstructing sand is removed.
			const confirmedClearance = s.queued === true ? CLEARANCE_PARTIALLY_BLOCKED : CLEARANCE_AVAILABLE;
			const pos = force ? { x: s.x, y: s.y, clearance: confirmedClearance } : { x: s.x, y: s.y };
			const buildOptions = s.data !== undefined ? { data: s.data } : {};
			const built = SA.build(state, pos, s.type, buildOptions);
			if (built) {
				if (Object.prototype.hasOwnProperty.call(s, "frame")) built.frame = s.frame === true ? true : undefined;
				// Native placement initializes filters from the local player's default selection.
				// Replace it only when the confirmed native structure actually supports filters.
				if (s.filter !== undefined && built.filter !== undefined) built.filter = JSON.parse(JSON.stringify(s.filter));
				// Always propagate host structures to simulation workers, not only when structure data is present.
				// Otherwise the structure enters the store but the running host simulation does not know or render it.
				// (the client with the sim in PAUZIE draws it from the store anyway - hence "the client sees, the host does not see").
				// (fix 0.5.4: installation of the invisible client on the host side)
				if (SA.update && (sandustryMP.net.role === "host" || s.data)) SA.update(state, built, { propagateToWorkers: sandustryMP.net.role === "host" });
			}
			return built;
		} catch (e) { log("buildOne error:", s.type, e.message); return null; }
	}
	function removeOne(state, s) {
		try { const SA = structNs(); if (SA) SA.removeAt(state, s.x, s.y, {}); } catch (e) { log("removeOne error:", e.message); }
	}

	function applyNetStructs(msg) {
		const state = sandustryMP.state;
		if (!state || !sandustryMP.gameApi) return;
		sandustryMP._applyingNet = true;
		try {
			// client renders confirmed structures: force=true (no collision check, no cell saving)
			if (msg.k === "add") for (const s of msg.list) { buildOne(state, s, true); sandustryMP._structApplied.set(structKey(s), performance.now()); }
			else if (msg.k === "rm") for (const s of msg.list) removeOne(state, s);
			else if (msg.k === "mv") { for (const s of msg.from) removeOne(state, s); for (const s of msg.to) { buildOne(state, s, true); sandustryMP._structApplied.set(structKey(s), performance.now()); } }
		} finally { sandustryMP._applyingNet = false; }
	}

	function applyPlacementResult(msg) {
		if (Number.isInteger(msg.q) && msg.q > 0) {
			if (!sandustryMP._pendingPlacements || !sandustryMP._pendingPlacements.has(msg.q)) return;
			sandustryMP._pendingPlacements.delete(msg.q);
		}
		if (msg.replaced) removeOne(sandustryMP.state, msg.replaced);
		if (msg.result === "failure") {
			if ((sandustryMP._placementRejectDiag = (sandustryMP._placementRejectDiag || 0) + 1) <= 100) log("CLIENT placement rejected by host @", msg.x, msg.y);
			return;
		}
		if ((msg.result !== "success" && msg.result !== "partial") || !msg.structure) return;
		const structure = msg.structure;
		// The verification result is authoritative. A successful result is complete;
		// a partial result retains the host's native queued/frame state.
		if (msg.result === "success") { structure.queued = false; structure.frame = false; }
		else if (structure.queued !== true && structure.frame !== true) structure.queued = true;
		applyNetStructs({ k: "add", list: [structure] });
	}

	async function sendSnapshotIfDue(state) {
		const now = performance.now();
		if (now - sandustryMP._lastSnap < 2500) return;
		sandustryMP._lastSnap = now;
		try {
			const payload = JSON.stringify({
				s: (state.store.structures || []).map(slimStruct),
				p: (state.store.pipes || []).map(slimStruct),
				wi: state.store.worldItems || [],
				dr: state.store.drones || [],
			});
			const packed = await deflate(new TextEncoder().encode(payload));
			net.send({ t: "snap", d: encodeBase64(packed) });
		} catch (e) { log("snapshot error:", e.message); }
	}

	async function applySnapshot(msg) {
		const state = sandustryMP.state;
		if (!state || !sandustryMP.gameApi) return;
		const snap = JSON.parse(new TextDecoder().decode(await inflate(decodeBase64(msg.d))));
		sandustryMP._applyingNet = true;
		try {
			const nowS = performance.now();
			for (const [hostList, localList] of [[snap.s, state.store.structures || []], [snap.p, state.store.pipes || []]]) {
				const hostMap = new Map(hostList.map((s) => [structKey(s), s]));
				// RECONCILE ETAPOWY (Knight-HD: additive fix + our safety net):
				// Do not delete immediately based on snapshot absence; transient key mismatches previously removed fresh buildings.
				// Purely additive reconciliation, however, left permanent ghosts.
				// WIECZNE ghosts (structures deleted by sim / in disconnect window - no "st rm" event).
				// Kompromis: delete only when structure is absent in >=3 KOLEJNYCH snapshots (~7.5 s)
				// And it was not freshly placed/confirmed (30 s of _structApplied protection).
				if (!sandustryMP._absentCount) sandustryMP._absentCount = new Map();
				for (const s of localList) {
					const k = structKey(s);
					if (hostMap.has(k)) { sandustryMP._absentCount.delete(k); continue; }
					const cnt = (sandustryMP._absentCount.get(k) || 0) + 1;
					sandustryMP._absentCount.set(k, cnt);
					const appliedTs = sandustryMP._structApplied.get(k);
					const fresh = appliedTs != null && nowS - appliedTs < 30000;
					if (cnt >= 3 && !fresh) {
						log("RECONCILE: removing ghost structure (absent from " + cnt + " snapshots):", k);
						removeOne(state, s);
						sandustryMP._absentCount.delete(k); sandustryMP._structApplied.delete(k);
					}
				}
				// add/update missing ones (client: force=true - render without cell collision/saving checks)
				for (const s of hostList) { buildOne(state, s, true); sandustryMP._structApplied.set(structKey(s), nowS); }
			}
			// worldItems: filter freshly raised locally (waiting for host acknowledgement, TTL 10 s)
			applyWorldItems(state, snap.wi || []);
		} catch (e) { log("reconcile error:", e.message); }
		finally { sandustryMP._applyingNet = false; }
	}
	function applyWorldItems(state, list) {
		const now = performance.now();
		for (const [id, ts] of sandustryMP._pickedPending) if (now - ts > 10000) sandustryMP._pickedPending.delete(id);
		state.store.worldItems = (list || []).filter((i) => !sandustryMP._pickedPending.has(i.id));
	}
	// SZYBKIE DROPY (G12): the new item on the ground arrived only with a 2.5s snapshot.
	// Host: for each ZMIANIE list, the id sends it immediately (checked at 5 Hz, sent only when changed).
	function sendWorldItemsIfChanged(state) {
		const now = performance.now();
		if (now - (sandustryMP._wiT || 0) < 200) return;
		sandustryMP._wiT = now;
		try {
			const wi = state.store.worldItems || [];
			let key = wi.length + ":";
			for (let i = 0; i < wi.length; i++) key += wi[i].id + ",";
			if (key === sandustryMP._wiKey) return;
			sandustryMP._wiKey = key;
			net.send({ t: "wi", wi });
		} catch (e) {}
	}

	// ------------------------------------------------------------------
	// ZASOBY - Host → Client (1 Hz)
	// ------------------------------------------------------------------
	function sendResourcesIfDue(state) {
		const now = performance.now();
		if (now - sandustryMP._lastRes < 1000) return;
		sandustryMP._lastRes = now;
		try {
			const sharedState = state.shared;
			const conveyorAnimationIndexes = unwrapTypedArray(sharedState.conveyorBeltsAnimationIndex);
			net.send({
				t: "res",
				r: state.store.resources,
				pp: state.store.productionPoints,
				g: unwrapTypedArray(sharedState.gold) ? unwrapTypedArray(sharedState.gold)[0] : null,
				e: unwrapTypedArray(sharedState.energy) ? unwrapTypedArray(sharedState.energy)[0] : null,
				p: unwrapTypedArray(sharedState.productionPoints) ? unwrapTypedArray(sharedState.productionPoints)[0] : null,
				c: conveyorAnimationIndexes ? Array.from(conveyorAnimationIndexes) : null,
				st: state.store.mods || null,           // story progress (storyProgression)
				gl: state.store.gloom || null,          // gloom condition
				fp: fpCounters(state),                  // factory process counters (ShakeWetSand etc.) - SAB non-mirror
				up: state.store.upgrades || null,       // Shared upgrade pool (fix G2)
				th: (state.store.player && state.store.player.tech) || null, // tech tree
				bu: (state.store.player && state.store.player.buildings) || null,
				vl: sandustryMP.gameApi.factory && sandustryMP.gameApi.factory.getLevel ? sandustryMP.gameApi.factory.getLevel(state) : null,
				pg: state.store.progression || null,    // progression (upgradesUnlocked, dungeons)
			});
		} catch (e) {}
	}
	// `factory.processing` counters are per-instance shared buffers and are not covered by the world mirror.
	// Stream progress for ShakeWetSand, PressBurntResidue, GrowFlowers, and CondenseFlorin so client UI is accurate.
	// (TCentraL, "shaking wet sand ain't working": the process succeeded on the host while the client UI remained unchanged.)
	// Odejmij customer purchase costs (common pool). Sanity: only numbers 0..1e9, clamp to zero.
	// Gold also lives in SAB (shared.gold) - we subtract in both places to make the UI match.
	function deductCosts(state, cost) {
		if (!cost) return;
		try {
			const r = state.store.resources || {};
			for (const k of Object.keys(cost)) {
				const v = cost[k];
				if (typeof v !== "number" || !(v > 0) || v > 1e9) continue;
				if (typeof r[k] === "number") r[k] = Math.max(0, r[k] - v);
				if (k === "gold") { const g = unwrapTypedArray(state.shared.gold); if (g) g[0] = Math.max(0, g[0] - v); }
				if (k === "energy") { const g = unwrapTypedArray(state.shared.energy); if (g) g[0] = Math.max(0, g[0] - v); }
			}
		} catch (e) {}
	}
	// PRAWDZIWE unlocking tech (fix ЗаКеЛьМан: "a friend examined the map, I don't have it").
	// Setting `tech[id]=true` alone is insufficient; `unlockTech` also registers buildings in the menu and creates
	// przedmioty do ekwipunku i emituje tech:mapUnlocked (minimapa!). _techMod = eksport
	// module 77135 via the "tech module export" patch.
	function techUnlock(state, techId, options) {
		const bypassCost = !!(options && options.bypassCost);
		const hadCheatState = !!(state && state.session && state.session.cheat);
		const cheatState = state && state.session && (state.session.cheat || (state.session.cheat = {}));
		const previousBypassCosts = cheatState && cheatState.bypassCosts;
		try {
			if (bypassCost && cheatState) cheatState.bypassCosts = true;
			const tm = sandustryMP._techMod;
			if (tm && tm.unlockTech && tm.getTechDefinition) {
				const def = tm.getTechDefinition(techId);
				if (def) {
					const unlocked = tm.unlockTech(state, def, { suppressMusic: true }) !== false;
					// Native unlockTech performs validation and side effects. Commit the
					// definition's canonical ID explicitly after success because remote calls
					// do not run through the research screen's local completion callback.
					if (unlocked && state.store.player && state.store.player.tech) {
						state.store.player.tech[def.id] = true;
						state.store.player.tech[techId] = true;
					}
					return unlocked;
				}
			}
		} catch (e) { log("techUnlock error:", techId, e.message); }
		finally {
			if (cheatState) cheatState.bypassCosts = previousBypassCosts;
			if (!hadCheatState && state && state.session) delete state.session.cheat;
		}
		return false;
	}
	function techSideEffectsFor(state) {
		if (sandustryMP._techSideEffectsState !== state) {
			sandustryMP._techSideEffectsState = state;
			sandustryMP._techSideEffectsApplied = new Set();
		}
		return sandustryMP._techSideEffectsApplied;
	}
	function canonicalTechKey(techId) {
		if (techId == null) return "";
		const key = String(techId).trim();
		return key && key !== "undefined" && key !== "null" ? key : "";
	}
	function researchLedger(state) {
		try {
			const storageApi = sandustryMP.gameApi && sandustryMP.gameApi.storage;
			return storageApi && typeof storageApi.ensure === "function" ? storageApi.ensure(state, "sandustryMPResearch") : null;
		} catch (e) { return null; }
	}
	function persistResearchLedger(state) {
		try {
			const player = state && state.store && state.store.player;
			const ledger = player && player.tech && researchLedger(state);
			if (!ledger) return;
			ledger.unlockedTechnologyIds = Object.keys(player.tech).filter((techId) => player.tech[techId] === true);
			ledger.version = 1;
		} catch (e) { log("RESEARCH LEDGER save error:", e.message); }
	}
	function restoreResearchLedger(state) {
		try {
			const player = state && state.store && state.store.player;
			const ledger = player && player.tech && researchLedger(state);
			if (!ledger || !Array.isArray(ledger.unlockedTechnologyIds)) return 0;
			let restored = 0;
			for (const techId of ledger.unlockedTechnologyIds) {
				if (techId == null || player.tech[techId] === true) continue;
				player.tech[techId] = true;
				restored++;
			}
			if (restored) log("RESEARCH LEDGER: restored", restored, "technology flags from the save ledger");
			return restored;
		} catch (e) { log("RESEARCH LEDGER load error:", e.message); return 0; }
	}
	function repairUnlockedResearch(state) {
		try {
			const techModule = sandustryMP._techMod;
			const player = state && state.store && state.store.player;
			if (!techModule || !techModule.unlockTech || !techModule.getTechDefinition || !player || !player.tech) return;
			restoreResearchLedger(state);
			const inventory = Array.isArray(player.inventory) ? player.inventory : (player.inventory = []);
			const ownedItemIds = new Set(inventory.map((item) => item && (item.id != null ? item.id : item.typeId)).filter((id) => id != null).map(String));
			const buildings = Array.isArray(player.buildings) ? player.buildings : (player.buildings = []);
			const technologyNodes = typeof techModule.getTechNodes === "function" ? techModule.getTechNodes() : [];
			const unlockedStructureIds = new Set();
			const lockedStructureIds = new Set();
			const unlockedItemIds = new Set();
			const lockedItemIds = new Set();
			let mapTechnologyKnown = false;
			let mapTechnologyUnlocked = false;
			let heatmapTechnologyUnlocked = false;
			for (const definition of technologyNodes) {
				if (!definition || definition.id == null || !definition.unlocks) continue;
				const techId = definition.id;
				const unlocked = player.tech[techId] === true;
				// Shaker is a starting building in normal saves even though the tutorial uses
				// a technology node for progression. Foundation and Collector are not present
				// in any unlock list, so they naturally remain untouched as well.
				const preserveStartingShaker = definition.descriptionKey === "tech|shaker|description";
				for (const structureId of definition.unlocks.structures || []) {
					const key = String(structureId);
					if (unlocked || preserveStartingShaker) unlockedStructureIds.add(key); else lockedStructureIds.add(key);
				}
				for (const itemId of definition.unlocks.items || []) {
					const key = String(itemId);
					if (unlocked) unlockedItemIds.add(key); else lockedItemIds.add(key);
				}
				if (definition.unlocks.map) {
					mapTechnologyKnown = true;
					if (unlocked) mapTechnologyUnlocked = true;
				}
				if (definition.descriptionKey === "tech|heatmap|description" && unlocked) heatmapTechnologyUnlocked = true;
			}
			const structuresToRemove = new Set([...lockedStructureIds].filter((id) => !unlockedStructureIds.has(id)));
			const itemsToRemove = new Set([...lockedItemIds].filter((id) => !unlockedItemIds.has(id)));
			let removedBuildings = 0;
			for (let index = buildings.length - 1; index >= 0; index--) {
				if (structuresToRemove.has(String(buildings[index]))) { buildings.splice(index, 1); removedBuildings++; }
			}
			let removedItems = 0;
			for (let index = inventory.length - 1; index >= 0; index--) {
				const item = inventory[index];
				const itemId = item && (item.id != null ? item.id : item.typeId);
				if (itemId != null && itemsToRemove.has(String(itemId))) { inventory.splice(index, 1); removedItems++; }
			}
			// Hotbars are player configuration, not an unlock registry. Never rewrite
			// them during load repair: a structure can be removed and restored later in
			// this same pass, but a cleared slot cannot be reconstructed reliably.
			if (removedBuildings || removedItems) log("RESEARCH REPAIR: removed locked unlocks:", removedBuildings, "buildings and", removedItems, "items");
			// `map.revealed` can remain true in saves affected by an earlier sync bug.
			// The map module caches that value during initialization, so repair both its
			// live state and persistent storage before restoring positive unlock effects.
			if (mapTechnologyKnown && sandustryMP._mapMod && typeof sandustryMP._mapMod.setRevealed === "function") {
				sandustryMP._mapMod.setRevealed(state, mapTechnologyUnlocked);
				let storedMapState = null;
				try { storedMapState = sandustryMP.gameApi.storage.ensure(state, "map"); } catch (e) {}
				log("RESEARCH REPAIR: map technology is", mapTechnologyUnlocked ? "unlocked" : "locked", "-> map revealed=" + !!(storedMapState && storedMapState.revealed));
			} else if (!sandustryMP._mapRepairWarningLogged) {
				sandustryMP._mapRepairWarningLogged = true;
				log("RESEARCH REPAIR: map state could not be reconciled; definition=" + mapTechnologyKnown, "nativeSetter=" + !!(sandustryMP._mapMod && sandustryMP._mapMod.setRevealed));
			}
			if (sandustryMP._mapMod && typeof sandustryMP._mapMod.setHeatmapUnlocked === "function") sandustryMP._mapMod.setHeatmapUnlocked(state, heatmapTechnologyUnlocked);
			let repairedTechnologies = 0;
			const previousApplyingNet = sandustryMP._applyingNet;
			sandustryMP._applyingNet = true;
			try {
				for (const techId of Object.keys(player.tech)) {
					if (!player.tech[techId]) continue;
					const definition = techModule.getTechDefinition(techId);
					if (!definition || !definition.unlocks) continue;
					const missingStructures = (definition.unlocks.structures || []).filter((structureId) => !buildings.includes(structureId));
					const missingItems = (definition.unlocks.items || []).filter((itemId) => !ownedItemIds.has(String(itemId)));
					const mapUnlock = definition.unlocks.map;
					if (!missingStructures.length && !missingItems.length && !mapUnlock) continue;
					const repairDefinition = Object.assign({}, definition, {
						cost: 0,
						unlocks: Object.assign({}, definition.unlocks, {
							structures: missingStructures,
							items: missingItems,
							map: mapUnlock
						})
					});
					let repaired = false;
					player.tech[techId] = false;
					try { repaired = techModule.unlockTech(state, repairDefinition, { suppressMusic: true, skipCostCheck: true }) !== false; }
					finally { player.tech[techId] = true; }
					if (!repaired) continue;
					for (const structureId of missingStructures) if (!buildings.includes(structureId)) buildings.push(structureId);
					for (const itemId of missingItems) ownedItemIds.add(String(itemId));
					techSideEffectsFor(state).add(canonicalTechKey(techId));
					repairedTechnologies++;
				}
			} finally { sandustryMP._applyingNet = previousApplyingNet; }
			if (repairedTechnologies) log("RESEARCH REPAIR: restored unlock side effects for", repairedTechnologies, "technologies");
		} catch (e) { log("RESEARCH REPAIR error:", e.message); }
	}
	function structureUnlockFamily(structureType) {
		if (structureType == null) return "";
		if (typeof structureType === "number") {
			if (structureType === 1 || structureType === 2) return "native:conveyor";
			if (structureType === 3 || structureType === 4) return "native:shaker";
			if (structureType >= 5 && structureType <= 7) return "native:launcher";
			if (structureType === 17 || structureType === 18) return "native:filter";
			return "native:" + structureType;
		}
		return "named:" + String(structureType).replace(/(left|right|up|down)$/i, "").toLowerCase();
	}
	function technologyControlledStructureFamilies() {
		const families = new Set();
		const techModule = sandustryMP._techMod;
		const nodes = techModule && typeof techModule.getTechNodes === "function" ? techModule.getTechNodes() : [];
		for (const definition of nodes) for (const structureType of (definition && definition.unlocks && definition.unlocks.structures) || []) families.add(structureUnlockFamily(structureType));
		return families;
	}
	function canHostPlaceStructure(state, structureType) {
		const requestedFamily = structureUnlockFamily(structureType);
		if (!requestedFamily || !technologyControlledStructureFamilies().has(requestedFamily)) return true;
		const unlockedBuildings = state.store.player && state.store.player.buildings;
		return Array.isArray(unlockedBuildings) && unlockedBuildings.some((buildingType) => structureUnlockFamily(buildingType) === requestedFamily);
	}
	function reconcileClientBuildingHotbar(state, hostBuildings) {
		if (!state || sandustryMP.net.role !== "client" || !Array.isArray(hostBuildings)) return;
		const hotbar = state.store.player && state.store.player.hotbar;
		if (!hotbar || !Array.isArray(hotbar.bars)) return;
		const controlledFamilies = technologyControlledStructureFamilies();
		const hostFamilies = new Set(hostBuildings.map(structureUnlockFamily));
		let removedSlots = 0;
		for (const bar of hotbar.bars) if (Array.isArray(bar)) for (let slotIndex = 0; slotIndex < bar.length; slotIndex++) {
			const entry = bar[slotIndex];
			const entryId = entry && typeof entry === "object" ? (entry.id != null ? entry.id : entry.typeId) : entry;
			const family = structureUnlockFamily(entryId);
			if (family && controlledFamilies.has(family) && !hostFamilies.has(family)) { bar[slotIndex] = null; removedSlots++; }
		}
		if (removedSlots) log("CLIENT removed", removedSlots, "hotbar building slots not unlocked by the host");
	}
	function applySyncedTechUnlock(state, techId) {
		const key = canonicalTechKey(techId);
		if (!state || !key || !state.store.player || !state.store.player.tech) return false;
		const applied = techSideEffectsFor(state);
		if (applied.has(key)) {
			state.store.player.tech[techId] = true;
			return true;
		}
		const previousApplyingNet = sandustryMP._applyingNet;
		sandustryMP._applyingNet = true;
		let fullyUnlocked = false;
		try {
			// A resource snapshot can set the flag before this reliable technology message
			// arrives. Clear it so native unlockTech still runs every unlock side effect
			// (notably tech:mapUnlocked), while bypassing a second local resource charge.
			state.store.player.tech[techId] = false;
			fullyUnlocked = techUnlock(state, techId, { bypassCost: true });
			state.store.player.tech[techId] = true;
			if (fullyUnlocked) applied.add(key);
			else {
				try { sandustryMP.gameApi.events.emit(state, "tech:unlocked", { techId, suppressMusic: true }); } catch (e) {}
			}
		} finally { sandustryMP._applyingNet = previousApplyingNet; }
		log("SYNC: team tech unlocked:", techId, fullyUnlocked ? "(REAL)" : "(FALLBACK flag - _techMod patch does not match!)");
		return fullyUnlocked;
	}
	function applySyncedFactoryTier(state, confirmedLevel) {
		const factory = sandustryMP.gameApi && sandustryMP.gameApi.factory;
		if (!state || !factory || !Number.isInteger(confirmedLevel) || confirmedLevel < 1 || confirmedLevel > 100) return false;
		let currentLevel = factory.getLevel ? factory.getLevel(state) : (state.store.viability && state.store.viability.level) || 1;
		if (currentLevel < confirmedLevel && factory.unlockNextTier) {
			const previousApplyingNet = sandustryMP._applyingNet;
			sandustryMP._applyingNet = true;
			try {
				while (currentLevel < confirmedLevel && (!factory.canUnlockNextTier || factory.canUnlockNextTier(state))) {
					const before = currentLevel;
					factory.unlockNextTier(state);
					currentLevel = factory.getLevel ? factory.getLevel(state) : (state.store.viability && state.store.viability.level) || before;
					if (currentLevel <= before) break;
				}
			} finally { sandustryMP._applyingNet = previousApplyingNet; }
		}
		currentLevel = factory.getLevel ? factory.getLevel(state) : (state.store.viability && state.store.viability.level) || 1;
		// The streamed host level is also the rollback path for an optimistic client
		// unlock rejected by native validation on the host.
		if (currentLevel !== confirmedLevel && state.store.viability) state.store.viability.level = confirmedLevel;
		try {
			const overlays = sandustryMP.gameApi.ui && sandustryMP.gameApi.ui.overlays;
			if (overlays && overlays.update) { overlays.update(state, "factoryProgress"); overlays.update(state, "management"); overlays.update(state, "global"); }
		} catch (e) {}
		return true;
	}
	function fpArr(state) { // raw SAB array (to be written at the customer's)
		try {
			const workersApi = sandustryMP.gameApi.workers;
			const processingCounters = workersApi && workersApi.shared && workersApi.shared.get && workersApi.shared.get(state, "factory.processing");
			return processingCounters && processingCounters.length ? processingCounters : null;
		} catch (e) { return null; }
	}
	function fpCounters(state) { const processingCounters = fpArr(state); return processingCounters ? Array.from(processingCounters) : null; }
	function updateClientConveyorAnimations(state, hostAnimationIndexes) {
		if (!state || sandustryMP.net.role !== "client" || !sandustryMP._baseWorldReady) return;
		const animationIndexes = unwrapTypedArray(state.shared && state.shared.conveyorBeltsAnimationIndex);
		if (!animationIndexes || animationIndexes.length < 2) return;
		const now = performance.now();
		if (sandustryMP._conveyorAnimationState !== state || !sandustryMP._conveyorAnimationStarted) {
			sandustryMP._conveyorAnimationState = state;
			sandustryMP._conveyorAnimationStarted = true;
			sandustryMP._lastConveyorAnimationStep = now;
			if (hostAnimationIndexes && hostAnimationIndexes.length >= 2) {
				animationIndexes[0] = hostAnimationIndexes[0] & 3;
				animationIndexes[1] = hostAnimationIndexes[1] & 3;
			}
			return;
		}
		// Sandustry's manager alternates left and right conveyor updates every 166 ms,
		// so each direction advances once every 332 ms. The client's manager is paused;
		// advance this render-only buffer locally instead of resetting it from a stale
		// one-second network snapshot. Filters use these same two animation indexes.
		const elapsed = now - sandustryMP._lastConveyorAnimationStep;
		const steps = Math.floor(elapsed / 332);
		if (steps <= 0) return;
		sandustryMP._lastConveyorAnimationStep += steps * 332;
		animationIndexes[0] = (animationIndexes[0] + steps) & 3;
		animationIndexes[1] = (animationIndexes[1] + steps) & 3;
	}
	function applyResources(msg) {
		const state = sandustryMP.state;
		if (!state) return;
		try {
			if (msg.r) Object.assign(state.store.resources, msg.r);
			if (msg.pp !== undefined) state.store.productionPoints = msg.pp;
			const sharedState = state.shared;
			if (msg.g !== null && unwrapTypedArray(sharedState.gold)) unwrapTypedArray(sharedState.gold)[0] = msg.g;
			if (msg.e !== null && unwrapTypedArray(sharedState.energy)) unwrapTypedArray(sharedState.energy)[0] = msg.e;
			if (msg.p !== null && unwrapTypedArray(sharedState.productionPoints)) unwrapTypedArray(sharedState.productionPoints)[0] = msg.p;
			if (msg.c) updateClientConveyorAnimations(state, msg.c);
			if (msg.st) {
				// `store.mods` contains team story progress and collections, but also per-player preferences.
				// Fix TCentraL: "client shake only works when the host has Shaking enabled" - switch
				// `mods.grabberSizeScroll` was overwritten with host state every second. Preserve local preferences.
				// we keep it in the override (expandable list if the game kept more UI settings here).
				const prevMods = state.store.mods || {};
				state.store.mods = msg.st;
				for (const k of ["grabberSizeScroll"]) if (prevMods[k] !== undefined) state.store.mods[k] = prevMods[k];
				// Augments (TCentraL: client trapped in selection screen): a fresh local client selection
				// (act:aug en route) cannot be overwritten by stream - 5s protection window; outside of it, the host rules.
				if (sandustryMP._augEditT && performance.now() - sandustryMP._augEditT < 5000 && prevMods.augments !== undefined) state.store.mods.augments = prevMods.augments;
				try { sandustryMP._augLast = JSON.stringify(state.store.mods.augments || null); } catch (e) {}
			}
			if (msg.gl) state.store.gloom = msg.gl;
			if (msg.fp) { const processingCounters = fpArr(state); if (processingCounters) { const sourceCounters = msg.fp; for (let index = 0; index < Math.min(processingCounters.length, sourceCounters.length); index++) { try { Atomics.store(processingCounters, index, sourceCounters[index]); } catch (e) { processingCounters[index] = sourceCounters[index]; } } } }
			if (msg.vl != null) applySyncedFactoryTier(state, msg.vl);
			// Shared upgrades and technology pool (G2): merge levels instead of replacing objects retained by the game.
			if (msg.up && state.store.upgrades) {
				for (const it of Object.keys(msg.up)) {
					const src = msg.up[it], dst = state.store.upgrades[it];
					if (!src || !dst) continue;
					for (const ug of Object.keys(src)) {
						const s = src[ug], d = dst[ug];
						// only UP: a fresh customer purchase cannot blink down before the host processes the act (upgrades do not drop)
						if (s && d && typeof s.level === "number" && s.level > (d.level || 0)) { d.level = s.level; d.availableLevel = Math.max(d.availableLevel || 0, s.availableLevel != null ? s.availableLevel : s.level); }
					}
				}
			}
			if (msg.th && state.store.player && state.store.player.tech) {
				for (const k of Object.keys(msg.th)) {
					if (!msg.th[k]) continue;
					// Do not trust the local flag: an earlier snapshot may have set it without registering the unlocked buildings.
					applySyncedTechUnlock(state, k);
				}
			}
			if (msg.bu) reconcileClientBuildingHotbar(state, msg.bu);
			if (msg.pg && state.store.progression) Object.assign(state.store.progression, msg.pg);
				sandustryMP._resSnapshot = Object.assign({}, state.store.resources); // re-base for customer increments (dotNine)
		} catch (e) {}
	}

	// ------------------------------------------------------------------
	// ENCJE (missiles/drones/creatures) - host → client 10 Hz; bullets as ghosts
	// ------------------------------------------------------------------
	// Every second, clients send acquired resource deltas to the host, which owns the persistent counters.
	// Without this channel, client earnings disappear after disconnecting. Contributed by dotNine.
	function sendResourceDeltaIfDue(state) {
		const now = performance.now();
		if (now - (sandustryMP._lastResDelta || 0) < 1000) return;
		sandustryMP._lastResDelta = now;
		if (sandustryMP._resSnapshot == null) return;
		try {
			const cur = state.store.resources || {};
			const prev = sandustryMP._resSnapshot;
			const delta = {}; let any = false;
			for (const k of Object.keys(cur)) { const d = (cur[k] || 0) - (prev[k] || 0); if (d > 0) { delta[k] = d; any = true; } }
			if (any) net.send({ t: "resDelta", r: delta });
			sandustryMP._resSnapshot = Object.assign({}, cur);
		} catch (e) {}
	}
	function applyResourceDelta(msg) {
		const state = sandustryMP.state;
		if (!state || !msg.r) return;
		try { const res = state.store.resources || (state.store.resources = {}); for (const k of Object.keys(msg.r)) res[k] = (res[k] || 0) + msg.r[k]; } catch (e) {}
	}

	const slimProj = (p) => ({ x: p.x, y: p.y, type: p.type });
	function sendEntitiesIfDue(state) {
		const now = performance.now();
		if (now - sandustryMP._lastEnt < 100) return;
		sandustryMP._lastEnt = now;
		try {
			net.send({
				t: "ent",
				pr: (state.store.projectiles || []).map(slimProj),
				dr: state.store.drones || [],
				cr: state.store.creatures || {},
			});
		} catch (e) {}
	}
	function applyEntities(msg) {
		const state = sandustryMP.state;
		if (!state) return;
		try {
			sandustryMP.remoteProjectiles = msg.pr || []; // Render as ghosts; never add them to the store or simulate them twice.
			if (msg.dr) state.store.drones = msg.dr;
			if (msg.cr) state.store.creatures = msg.cr;
		} catch (e) {}
	}
	// client sends its own projectiles (host draws them as ghosts)
	function sendMyProjectilesIfDue(state) {
		const now = performance.now();
		if (now - sandustryMP._lastMyProj < 100) return;
		sandustryMP._lastMyProj = now;
		const list = (state.store.projectiles || []).map(slimProj);
		if (list.length || sandustryMP._hadProj) { try { net.send({ t: "myproj", list }); } catch (e) {} }
		sandustryMP._hadProj = list.length > 0;
	}

	// ------------------------------------------------------------------
	// World-event sounds: tap host worker messages (`PlaySound=41`).
	// ------------------------------------------------------------------
	(function hookWorkers() {
		const NativeWorker = window.Worker;
		const desc = Object.getOwnPropertyDescriptor(NativeWorker.prototype, "onmessage");
		let sndBudget = 0, sndWindow = 0;
		const forwardSoundEvent = (event) => {
			try {
				const messageData = event.data;
				if (!Array.isArray(messageData) || messageData[0] !== 41) return;
				if (sandustryMP.net.role !== "host" || !sandustryMP.peers.size) return;
				const now = performance.now();
				if (now - sndWindow > 1000) { sndWindow = now; sndBudget = 0; }
				if (sndBudget++ > 20) return; // limit of 20 sounds/s
				net.send({ t: "snd", a: messageData.slice(1, 6) });
			} catch (e) {}
		};
		window.Worker = function (url, options) {
			const worker = new NativeWorker(url, options);
			try {
				Object.defineProperty(worker, "onmessage", {
					get() { return desc.get.call(worker); },
					set(handler) { desc.set.call(worker, handler ? (event) => { forwardSoundEvent(event); return handler(event); } : handler); },
				});
				worker.addEventListener("message", forwardSoundEvent);
			} catch (e) {}
			return worker;
		};
		window.Worker.prototype = NativeWorker.prototype;
	})();
	function playRemoteSound(msg) {
		try {
			const state = sandustryMP.state;
			const snd = sandustryMP.gameApi && sandustryMP.gameApi.sound;
			if (!state || !snd || !msg.a) return;
			const [name, x, y] = msg.a;
			if (typeof name !== "string") return;
			if (typeof snd.playAt === "function") snd.playAt(state, name, x, y);
			else if (typeof snd.play === "function") snd.play(state, name, typeof x === "number" ? { position: { x, y } } : undefined);
			else if (!sandustryMP._sndWarned) { sandustryMP._sndWarned = true; log("FH.sound keys:", Object.keys(snd).join(",")); }
		} catch (e) {}
	}

	// ------------------------------------------------------------------
	// VACUUM - Client sends intent, host collects items, types return to containers
	// ------------------------------------------------------------------
	sandustryMP._vac = (state, item, cell, vel) => {
		if (!isClientSync() || !sandustryMP.wsx.paused) return false; // host/offline/poza lustrem: normalnie
		const now = performance.now();
		if (now - sandustryMP._lastVac > 120) {
			sandustryMP._lastVac = now;
			const data = item && item.data;
			if (data && Array.isArray(data.tanks) && cell) {
				const sequence = (sandustryMP._vacSeq = (sandustryMP._vacSeq || 0) + 1);
				const tanks = data.tanks.map((tank) => ({
					elementType: Number.isInteger(tank && tank.elementType) ? tank.elementType : 0,
					amount: Math.max(0, Number.isFinite(tank && tank.amount) ? tank.amount : 0),
				}));
				try {
					net.send({
						t: "act", k: "vac", q: sequence, x: cell.x | 0, y: cell.y | 0,
						vx: Number.isFinite(vel && vel.x) ? vel.x : 0,
						vy: Number.isFinite(vel && vel.y) ? vel.y : 0,
						d: {
							tanks,
							activeTankIdx: Number.isInteger(data.activeTankIdx) ? data.activeTankIdx : 0,
							filter: { elementType: Number.isInteger(data.filter && data.filter.elementType) ? data.filter.elementType : null },
							onlyFillActiveTank: data.onlyFillActiveTank === true,
						},
					});
				} catch (e) {}
			}
		}
		return true; // skip local tick (reads stale cellIds)
	};

	// Host-side grabber (vacuum model v1): while collecting, the client forwards intent instead of reading stale mirrored cells.
	// WIZ (mouse.cellPosition), host collects authoritatively (getInfoAtPos+isGrabbable+removeAt) and sends back types,
	// the client fills the tank. This remains active for partially filled tanks; switching back to the local
	// collection path after the first particle could leave the grabber stuck at one item. Placement still uses
	// the native path because the grab control is not active then.
	function getSelectedGrabberWidth(tool) {
		const data = tool && tool.data;
		const selectedCellCount = data && Number(data.size);
		const selectedWidth = Math.sqrt(selectedCellCount);
		if (Number.isInteger(selectedWidth) && selectedWidth >= 1 && selectedWidth <= 32) return selectedWidth;
		const matrixCellCount = data && data.matrix ? data.matrix.length - 2 : 1;
		return Math.max(1, Math.min(32, Math.floor(Math.sqrt(matrixCellCount))));
	}
	// Match Sandustry's `$` helper exactly: start at the cursor cell, then visit
	// successive Chebyshev rings. For even sizes the native helper generates the
	// outer positive edge too and discards coordinates outside the matrix.
	function getNativeGrabberOffsets(grabberSize) {
		const offsets = [];
		const matrixCenter = Math.floor(grabberSize / 2);
		offsets.push([0, 0]);
		for (let radius = 1; radius <= matrixCenter; radius++) {
			for (let rowOffset = -radius; rowOffset <= radius; rowOffset++) {
				for (let columnOffset = -radius; columnOffset <= radius; columnOffset++) {
					if (Math.max(Math.abs(columnOffset), Math.abs(rowOffset)) !== radius) continue;
					const matrixColumn = matrixCenter + columnOffset;
					const matrixRow = matrixCenter + rowOffset;
					if (matrixColumn < 0 || matrixColumn >= grabberSize || matrixRow < 0 || matrixRow >= grabberSize) continue;
					offsets.push([columnOffset, rowOffset]);
				}
			}
		}
		return offsets;
	}
	sandustryMP._grab = (state, tool) => {
		try {
			if (!isClientSync() || !sandustryMP.wsx.paused) return false; // host/offline or client outside the host world
			const B = tool && tool.data && tool.data.matrix;
			if (!B) return false;
			// Collect only while the player actively holds the grab control (`action.state[qy.Active] === 2`).
			// Continuous forwarding previously collected falling elements without user input.
			const ast = state.session && state.session.action && state.session.action.state;
			if (!ast || !ast[2]) return false; // no action → let z() do hover (no download)
			const now = performance.now();
			if (now - (sandustryMP._lastGrabH || 0) > 100) {
				const pendingGrab = sandustryMP._grabPending;
				if (pendingGrab && now - pendingGrab.time < 1500) return true;
				sandustryMP._grabPending = null;
				sandustryMP._lastGrabH = now;
				const m = state.session && state.session.input && state.session.input.mouse;
				const cp = m && m.cellPosition;
				if (cp && cp.x >= 0 && cp.y >= 0) {
					// `matrix` is allocated to the maximum upgraded capacity; `data.size` is the
					// currently selected area. Counting the entire allocation made a selected 5x5
					// grabber harvest a 7x7 area on the host.
					const grabberSize = getSelectedGrabberWidth(tool);
					const selectedCellCount = grabberSize * grabberSize;
					const freeSlots = [];
					for (let i = 2; i < Math.min(B.length, selectedCellCount + 2); i++) if (B[i] === 0) freeSlots.push(i - 2);
					const free = freeSlots.length;
					if (free > 0) {
						sandustryMP._grabTool = tool; // remember to fill the tank after the host responds
						const requestSequence = (sandustryMP._grabRequestSequence = (sandustryMP._grabRequestSequence || 0) + 1);
						sandustryMP._grabPending = { q: requestSequence, time: now };
						try { net.send({ t: "act", k: "grabH", q: requestSequence, x: cp.x | 0, y: cp.y | 0, f: free, fs: freeSlots, s: grabberSize, lt: B[0] || 0 }); }
						catch (e) { sandustryMP._grabPending = null; }
						if ((sandustryMP._grabHDiag = (sandustryMP._grabHDiag || 0) + 1) <= 40) log("CLIENT grabH forward @", cp.x | 0, cp.y | 0, "size=" + grabberSize, "free=" + free, "lock=" + (B[0] || 0));
					}
				}
			}
			return true; // skip local collection (host will do it authoritatively)
		} catch (e) { return false; }
	};
	// HOST: collect grabbable elements in radius around (x,y), remove, send types back to client (like vacuum).
	function hostHarvestGrab(msg, fromId) {
		const state = sandustryMP.state;
		if (!state || !sandustryMP.gameApi) return;
		// rate-limit per player (the client limits itself to 100ms, but the host cannot trust the client)
		if (!sandustryMP._grabHLast) sandustryMP._grabHLast = new Map();
		const tNow = performance.now();
		if (tNow - (sandustryMP._grabHLast.get(fromId) || 0) < 80) return;
		sandustryMP._grabHLast.set(fromId, tNow);
		const el = sandustryMP.gameApi.elements || {};
		const getInfo = el.getInfoAtPos;
		const removeAt = el.removeAt;
		if (!getInfo || !removeAt) { if (!sandustryMP._grabApiWarned) { sandustryMP._grabApiWarned = true; log("ERROR grabH: missing getInfoAtPos/removeAt — el:", Object.keys(el).join(",")); } return; }
		const types = [], offs = [];
		// The empty client tank is a square matrix. Use its exact width for the authoritative selection;
		// the old fixed radius scanned 9x9 even when the equipped grabber was only 1x1 through 5x5.
		const freeSlots = Math.max(1, Math.min(1024, Number.isInteger(msg.f) ? msg.f : 1));
		const inferredSize = Math.max(1, Math.floor(Math.sqrt(freeSlots)));
		const requestedSize = Number.isInteger(msg.s) && msg.s > 0 && msg.s <= 32 ? msg.s : inferredSize;
		// Remaining capacity limits how many cells may be taken, not the selection width.
		// Shrinking the AOE whenever the tank gained an item made a 5x5 selection become
		// 4x4 after the first pickup, so dragging across a foundation stopped reaching gold.
		const grabberSize = requestedSize;
		const cap = Math.min(freeSlots, grabberSize * grabberSize);
		const freeSlotIndexes = Array.isArray(msg.fs)
			? new Set(msg.fs.filter((slotIndex) => Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < grabberSize * grabberSize))
			: null;
		// BRAMKA NAUKOWA (fix derErste67: customer collected water without testing): vanilla grabber requires
		// grabber.waterGrab upgrade for LIQUIDS - host-side harvest must enforce this the same.
		// matterType "Liquid" is set dynamically from the water config (RJ.Water=3) - without the enuma hardcode.
		if (sandustryMP._mtLiquid === undefined) { try { const wc = el.getConfig && el.getConfig(3); sandustryMP._mtLiquid = wc && wc.matterType != null ? wc.matterType : null; } catch (e) { sandustryMP._mtLiquid = null; } }
		const wg = state.store.upgrades && state.store.upgrades.grabber && state.store.upgrades.grabber.waterGrab;
		const canLiquid = !!(wg && wg.level);
		let gateSkipped = 0;
		// JEDEN TYP NA TANK (fix derErste67 #2: "grabbing dirt also grabs stone and gold"): vanilla
		// Lock the tank to the first captured type (`T[0]`; `if(L&&U!==L)continue`). The client can send
		// locked tank type (msg.lt); with an empty tank, the first element collected defines the lock.
		let lockType = (typeof msg.lt === "number" && msg.lt > 0) ? msg.lt : 0;
		let taken = 0;
		// Native selection is centre-first, expanding one square ring at a time.
		// Preserve that order because it decides which particles win when there are
		// more eligible cells than remaining tank slots.
		for (const [dx, dy] of getNativeGrabberOffsets(grabberSize)) {
			if (taken >= cap) break;
			// Grabber storage is spatial. A particle can only enter the matrix slot at
			// the same offset from the cursor; occupied slots must not redirect nearby
			// particles into an unrelated empty slot elsewhere in the influence area.
			if (freeSlotIndexes) {
				const matrixCenter = grabberSize >> 1;
				const column = dx + matrixCenter, row = dy + matrixCenter;
				const slotIndex = column + row * grabberSize;
				if (!freeSlotIndexes.has(slotIndex)) continue;
			}
			const x = msg.x + dx, y = msg.y + dy;
			try {
				const info = getInfo(state, x, y);
				if (!info || !info.elementType) continue;
				if (info.isGrabbable === false) continue; // respect the flag when there is one; when there is no supply - take it (the client aimed)
				const cfg = el.getConfig ? el.getConfig(info.elementType) : null;
				if (cfg && cfg.isGrabbable === false) continue;
				if (sandustryMP._mtLiquid !== null && cfg && cfg.matterType === sandustryMP._mtLiquid && !canLiquid) { gateSkipped++; continue; } // liquid without waterGrab testing
				if (lockType && info.elementType !== lockType) continue; // tank only accepts JEDEN type (like vanilla)
				if (!lockType) lockType = info.elementType;
				removeAt(state, x, y);
				markCellDirty(state, x, y);
				types.push(info.elementType);
				offs.push(dx, dy); // position relative cursor → the client maps to the appropriate tank grid slot
				taken++;
			} catch (e) {}
		}
		net.send({ t: "grabres", q: Number.isInteger(msg.q) ? msg.q : 0, types, offs }, fromId);
		if (types.length) { if ((sandustryMP._grabHostDiag = (sandustryMP._grabHostDiag || 0) + 1) <= 40) log("HOST grabH @", msg.x, msg.y, "size=" + grabberSize + "x" + grabberSize, "collected", types.length, "elements" + (gateSkipped ? " (omitted " + gateSkipped + " fluids - no waterGrab)" : "")); }
		else if (gateSkipped && (sandustryMP._grabGateDiag = (sandustryMP._grabGateDiag || 0) + 1) <= 10) log("HOST grabH: collected 0 elements;", gateSkipped, "fluids blocked (no waterGrab upgrade)");
	}
	// Client: populate the grabber tank matrix with host-confirmed types. `B[0]` is the locked type, `B[1]` the count, and `B[2..]` the slots.
	function clientFillGrabTank(types, offs) {
		const tool = sandustryMP._grabTool;
		const B = tool && tool.data && tool.data.matrix;
		if (!B || !types || !types.length) return;
		// SLOT According to POZYCJI (fix TCentraL: items landed in the upper left corner of the picker): the tank grid is
		// spatial - slot corresponds to the position of the cell relative to the cursor (vanilla: A = w + t*v). Host
		// Sends offsets `(dx,dy)`; slot = `(dx+mid) + (dy+mid)*v`. Occupied or out of range uses the first free slot.
		const v = getSelectedGrabberWidth(tool);
		const selectedCellCount = v * v;
		const mid = v >> 1;
		let filledAny = false;
		for (let ti2 = 0; ti2 < types.length; ti2++) {
			const ty = types[ti2];
			let filled = false;
			if (offs && offs.length >= (ti2 + 1) * 2) {
				const col = offs[ti2 * 2] + mid, row = offs[ti2 * 2 + 1] + mid;
				if (col >= 0 && col < v && row >= 0 && row < v) {
					const idx = 2 + col + row * v;
					if (idx < B.length && B[idx] === 0) { B[idx] = ty; B[1] = (B[1] || 0) + 1; if (!B[0]) B[0] = ty; filled = true; filledAny = true; }
				}
			}
			// Older hosts did not include positional offsets. Retain their sequential
			// compatibility behavior, but never relocate a position-aware response.
			if (!filled && (!offs || offs.length < (ti2 + 1) * 2)) for (let i = 2; i < Math.min(B.length, selectedCellCount + 2); i++) { if (B[i] === 0) { B[i] = ty; B[1] = (B[1] || 0) + 1; if (!B[0]) B[0] = ty; filled = true; filledAny = true; break; } }
			if (!filled) break; // tank full
		}
		if (filledAny && (sandustryMP._grabFillDiag = (sandustryMP._grabFillDiag || 0) + 1) <= 20) log("CLIENT grabber tank filled with:", types.length, "types, count=" + B[1]);
	}

	// Flamethrower/cryoblaster: we queue cells (many/tick) and send in batches every ~60ms - we do not flood the network.
	// The client skips local creation, which would be deferred indefinitely while paused; the host recreates it authoritatively.
	sandustryMP._fireQ = []; sandustryMP._cryoQ = [];
	// `sandustryMP.wsx.paused` activates this hook only while the mirror is running on the host world.
	// A connected client on another world keeps normal local weapon behavior and forwards nothing.
	// (its coordinates make no sense in the host world).
	sandustryMP._fire = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return false; if (sandustryMP._fireQ.length < 2000) sandustryMP._fireQ.push(x, y); return true; };
	sandustryMP._cryo = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return; if (sandustryMP._cryoQ.length < 2000) sandustryMP._cryoQ.push(x, y); };
	// volcanizer (lawa) + caulkBlaster (spray/usuwanie caulku): ten sam wzorzec co cryo — sekwencja
	// before Lu (local Lu is dropped at the client anyway), batch every 60ms, host plays with guards.
	sandustryMP._volcQ = []; sandustryMP._caulkQ = []; sandustryMP._caulkRmQ = []; sandustryMP._shakeQ = [];
	// manual SHAKE grabber (fix TCentraL: "gold is created, residue disappears"): tank mutates locally
	// Gold enters the tank, but residue enters the world through `Lu` (dropped on clients) plus `recordProcess`.
	// only the local counter is ticking. Forward per processed slot → host creates residue and counts the process.
	sandustryMP._shakeRes = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return; if (sandustryMP._shakeQ.length < 2000) sandustryMP._shakeQ.push(x, y); };
	sandustryMP._volc = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return; if (sandustryMP._volcQ.length < 2000) sandustryMP._volcQ.push(x, y); };
	sandustryMP._caulk = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return; if (sandustryMP._caulkQ.length < 2000) sandustryMP._caulkQ.push(x, y); };
	sandustryMP._caulkRm = (state, x, y) => { if (!isClientSync() || !sandustryMP.wsx.paused) return; if (sandustryMP._caulkRmQ.length < 2000) sandustryMP._caulkRmQ.push(x, y); };

	function copyVacuumData(data) {
		if (!data || !Array.isArray(data.tanks) || data.tanks.length < 1 || data.tanks.length > 8) return null;
		return {
			tanks: data.tanks.map((tank) => ({
				elementType: Number.isInteger(tank && tank.elementType) && tank.elementType > 0 ? tank.elementType : 0,
				amount: Math.max(0, Number.isFinite(tank && tank.amount) ? tank.amount : 0),
			})),
			activeTankIdx: Number.isInteger(data.activeTankIdx) ? data.activeTankIdx : 0,
			filter: { elementType: Number.isInteger(data.filter && data.filter.elementType) ? data.filter.elementType : null },
			onlyFillActiveTank: data.onlyFillActiveTank === true,
		};
	}

	function sendNativeVacuumResult(tool, sequence, fromId) {
		const data = copyVacuumData(tool && tool.data);
		if (data) net.send({ t: "vacres", q: sequence, d: data }, fromId);
	}

	function hostHarvestVacuum(msg, fromId) {
		const state = sandustryMP.state;
		const nativeCollect = sandustryMP._vacuumMod && sandustryMP._vacuumMod.smpCollect;
		const vacuumData = copyVacuumData(msg.d);
		if (!state || typeof nativeCollect !== "function" || !vacuumData) {
			if (!sandustryMP._vacuumNativeWarned) {
				sandustryMP._vacuumNativeWarned = true;
				log("ERROR vacuum: native collector unavailable (patch 'vacuum native collector export' not applied?)");
			}
			return;
		}
		if (!sandustryMP._vacuumLast) sandustryMP._vacuumLast = new Map();
		const now = performance.now();
		if (now - (sandustryMP._vacuumLast.get(fromId) || 0) < 80) return;
		sandustryMP._vacuumLast.set(fromId, now);
		const sequence = Number.isInteger(msg.q) ? msg.q : 0;
		if (!sandustryMP._remoteVacuumTools) sandustryMP._remoteVacuumTools = new Map();
		let remoteVacuum = sandustryMP._remoteVacuumTools.get(fromId);
		if (remoteVacuum && sequence <= remoteVacuum.sequence) return;
		if (!remoteVacuum) {
			remoteVacuum = { sequence, tool: { data: vacuumData } };
			sandustryMP._remoteVacuumTools.set(fromId, remoteVacuum);
		} else {
			remoteVacuum.sequence = sequence;
			// The host owns tank contents after the first request. Selection controls
			// remain client inputs and may change without replacing authoritative amounts.
			remoteVacuum.tool.data.activeTankIdx = vacuumData.activeTankIdx;
			remoteVacuum.tool.data.filter = vacuumData.filter;
			remoteVacuum.tool.data.onlyFillActiveTank = vacuumData.onlyFillActiveTank;
		}
		const tool = remoteVacuum.tool;
		try {
			nativeCollect(state, tool, { x: msg.x | 0, y: msg.y | 0 }, {
				x: Number.isFinite(msg.vx) ? msg.vx : 0,
				y: Number.isFinite(msg.vy) ? msg.vy : 0,
			});
			sendNativeVacuumResult(tool, sequence, fromId);
			// Native removal is deferred and may roll the optimistic tank increment back.
			// Return the settled native state too; the sequence prevents an older retry
			// from overwriting a newer client action.
			setTimeout(() => {
				const current = sandustryMP._remoteVacuumTools && sandustryMP._remoteVacuumTools.get(fromId);
				if (current && current.sequence === sequence) sendNativeVacuumResult(tool, sequence, fromId);
			}, 100);
		} catch (error) {
			log("Native vacuum error:", error.message);
		}
	}

	function clientApplyVacuumResult(msg) {
		const state = sandustryMP.state;
		if (!state || !msg) return;
		try {
			const inv = state.store.player.inventory || [];
			const vac = inv.find((i) => i && i.data && Array.isArray(i.data.tanks));
			if (!vac) return;
			if (msg.d) {
				const sequence = Number.isInteger(msg.q) ? msg.q : 0;
				if (sequence < (sandustryMP._vacAckSeq || 0)) return;
				const data = copyVacuumData(msg.d);
				if (!data) return;
				sandustryMP._vacAckSeq = sequence;
				vac.data.tanks = data.tanks;
				vac.data.activeTankIdx = data.activeTankIdx;
				vac.data.filter = data.filter;
				vac.data.onlyFillActiveTank = data.onlyFillActiveTank;
				try { sandustryMP.gameApi.ui && sandustryMP.gameApi.ui.overlays && sandustryMP.gameApi.ui.overlays.update && sandustryMP.gameApi.ui.overlays.update(state, "hotbar"); } catch (e) {}
				return;
			}
			// Compatibility with hosts from before the native-vacuum protocol.
			const types = Array.isArray(msg.types) ? msg.types : [];
			const tanks = vac.data.tanks;
			let level = 0;
			try { if (sandustryMP.gameApi && sandustryMP.gameApi.upgrades && sandustryMP.gameApi.upgrades.getLevel) level = sandustryMP.gameApi.upgrades.getLevel(state, "vacuum", "capacity") || 0; } catch (e) {}
			const capacity = VACUUM_CAPS[level] || VACUUM_CAPS[0];
			for (const elementType of types) {
				let tank = tanks.find((entry) => entry.elementType === elementType && entry.amount < capacity);
				if (!tank) tank = tanks.find((entry) => entry.elementType === 0 && entry.amount === 0);
				if (!tank) continue;
				tank.elementType = elementType;
				tank.amount++;
			}
		} catch (e) { log("applyVacuumResult error:", e.message); }
	}

	// ------------------------------------------------------------------
	// AKCJE — hooki z patchy bundle.js
	// ------------------------------------------------------------------
	// `_dig`: forward only player excavation (`_pd` from patch I) and impacts.
	// Forward only the client's own projectiles (`_projCtx` flag); remote projectiles never enter the store.
	// Do not forward excavation caused by creatures or drones; the host simulates those itself.
	sandustryMP._dig = (state, x, y, mask, vel, dmg, opts) => {
		if (!isClientSync() || !sandustryMP.wsx.paused) return false; // host/offline/poza lustrem: kop normalnie
		// Projectiles are simulated authoritatively by the host (`sandustryMP._proj`), so client projectile excavation is not forwarded.
		// from the projectile context (_projCtx), aka double holes (client projectile + host projectile).
		if (sandustryMP._projCtx) return true; // skip: the explosion/hole will be made by the host projectile
		try {
			net.send({ t: "act", k: "dig", x, y, m: mask, v: vel, d: dmg });
			if (!sandustryMP._digFwdLogged) { sandustryMP._digFwdLogged = true; log("DIG: first forward to host @", x, y, "(host should log 'client's first mine restored')"); }
		} catch (e) {}
		return true; // skip local execution (paused anyway)
	};
	// _drone (patch bundle on E=deploy): client deploys LOKALNIE drone → host sync overwrites store.drones →
	// the drone disappears. Forwardujemy drone to the host, the host adds it authoritatively (its sim "brings it to life").
	sandustryMP._drone = (state, drone) => {
		if (!isClientSync() || !sandustryMP.wsx.paused || sandustryMP._applyingNet) return;
		try { net.send({ t: "act", k: "drone", d: drone }); if ((sandustryMP._drDiag = (sandustryMP._drDiag || 0) + 1) <= 20) { let _dd = ""; try { _dd = JSON.stringify(drone && drone.data).slice(0, 300); } catch (e) {} log("CLIENT forward drone:", drone && drone.type, "@", drone && drone.x, drone && drone.y, "data=", _dd); } } catch (e) {}
	};
	// _proj (patch bundle on projectiles.push): client fires weapon → local missile (sim in pause = dead,
	// explosion doesn't work). Forwardujemy missile to host; the host uploads it to store.projectiles → its sim
	// simulates flight+explosion+dmg authoritatively, the result returns via a mirror/entity stream. (rocket/fusil)
	sandustryMP._proj = (state, proj) => {
		if (!isClientSync() || !sandustryMP.wsx.paused || sandustryMP._applyingNet) return;
		try { net.send({ t: "act", k: "proj", p: proj }); if ((sandustryMP._prDiag = (sandustryMP._prDiag || 0) + 1) <= 20) log("CLIENT forward proj:", proj && proj.type, "@", proj && Math.round(proj.x), proj && Math.round(proj.y)); } catch (e) {}
	};
	// `_setCell` (patch B/Gz): clients never write authoritative cells locally.
	// - when applying a structure from the network (_applyingNet): skip writing (the terrain will show the mapData mirror of the host)
	// - player spray (_sprayCtx): send intent to host
	// - skip the local save in any case
	sandustryMP._setCell = (state, x, y, cellId, opts) => {
		if (!isClientSync()) return false; // host/offline: normalnie
		if (!sandustryMP._applyingNet && sandustryMP._sprayCtx) { try { net.send({ t: "act", k: "set", x, y, c: cellId }); } catch (e) {} }
		return true; // NIGDY client does not save cells locally
	};
	// _dropLu: when the client is paused, the mutation queue never drains - don't let it grow
	sandustryMP._dropLu = () => isClientSync() && sandustryMP.wsx.paused;
	// _place (patch bundle, at SOURCE of put action - before runInterceptorsSafe("building:place")):
	// The client sends placement intent to the host and cancels local placement by returning true.
	// The host returns an explicit success/partial/failure result after native validation.
	// Host and offline modes return false for normal local placement. `buildOne` and `SA.build` do not pass through this hook.
	// hook (this is the lower-level API), so applying structures from the network and building the host do not loop.
	sandustryMP._place = (state, structureType, x, y, data) => {
		if (!isClientSync() || !sandustryMP.wsx.paused) return false; // host/offline/poza lustrem: stawiaj normalnie
		// KLUCZOWE: when MOD builds the structure itself from the network (applyNetStructs/applySnapshot → buildOne → SA.build,
		// Network-applied placement passes through `building:place`; do not capture it or confirmed rendering would be canceled.
		// Otherwise the client sees no buildings at all, either its own or the host's. This regressed after switching bundle patches.
		if (sandustryMP._applyingNet) return false;
		if (structureType == null) return false; // no type → do not block the game
		// KLUCZOWY FIX (0.5.4): we forward ANY type (string I NUMERYCZNY = enum ev). Wczesleep lock
		// Requiring `typeof === "string"` rejected numeric structure types, so most buildings were never forwarded.
		// Garde anti-flood: with WCZYTYWANIU the game launches building:place for multiple structures at once
		// Suppress forwarding for roughly three seconds after a scene change to avoid replaying hundreds of save-loaded placements.
		if (sandustryMP._loadGuardUntil && performance.now() < sandustryMP._loadGuardUntil) return false; // load → allow local reconstruction, do not forward
		if ((sandustryMP._plDiag2 = (sandustryMP._plDiag2 || 0) + 1) <= 300) log("CLIENT forward place:", structureType, "@", x, y, "(typeof " + typeof structureType + ")", data ? "with data" : "without data");
		// KLUCZOWE (fix "foundations cannot be removed"): we also forward DATA structures. Fundamenty
		// (box/slants/color) carry a definition in data - without it the host built ZDEGENEROWANA version, which
		// foundation removal path (drag) couldn't match → unremovable even for the host.
		let d = null;
		try { if (data != null) d = JSON.parse(JSON.stringify(data)); } catch (e) {} // only serializable fields
		let selectedFilter = null;
		try {
			const defaultFilter = state.store && state.store.options && state.store.options.defaultFilter;
			if (defaultFilter != null) selectedFilter = JSON.parse(JSON.stringify(defaultFilter));
		} catch (e) {}
		const requestId = (sandustryMP._placementSeq = (sandustryMP._placementSeq || 0) + 1);
		if (!sandustryMP._pendingPlacements) sandustryMP._pendingPlacements = new Map();
		sandustryMP._pendingPlacements.set(requestId, { type: structureType, x, y, time: performance.now() });
		// Bound abandoned requests if a peer disconnects during placement.
		if (sandustryMP._pendingPlacements.size > 256) sandustryMP._pendingPlacements.delete(sandustryMP._pendingPlacements.keys().next().value);
		let replace = false;
		try { replace = !!(sandustryMP.gameApi.input && sandustryMP.gameApi.input.isCtrlHeld && sandustryMP.gameApi.input.isCtrlHeld(state)); } catch (e) {}
		try { net.send({ t: "act", k: "place", q: requestId, type: structureType, x, y, data: d, filter: selectedFilter, replace }); } catch (e) {}
		return true; // cancel local placing - the client does not write anything to the world
	};

	// Demolisher client (hook _demol from tool tick, branch End drag).
	// Client-side local demolition does not complete reliably because some work is deferred while the simulation is paused.
	// queues/workers of a paused sim) → only red mark, event structures:removed does not fire,
	// No event is emitted until confirmation ("recolors them red, and that's it" - TCentraL), so capture intent instead:
	// find structures in the selected rect after LUSTRZE (getAtCell on rect cells - accuracy as
	// game, takes shape into account) and send it via the existing act demolish channel. Host deletes, st rm confirms.
	sandustryMP._demol = (state, start, end) => {
		try {
			// Host and solo modes use normal demolition, but remember the rectangle for a delayed cleanup pass.
			// Finish leftovers through `SA.removeAt`; building tiles created by client replay can
			// get stuck in the state QUEUED (block-access), and demolition of the game such tiles POMIJA → "red
			// blocks that even the host cannot remove. SA.removeAt takes a different path and takes them down.
			// Solo and offline modes also work because jammed blocks persist in saves and must be removable without a session.
			if (!isClientSync() || !sandustryMP.wsx.paused) {
				// TRYB RUR (raport TCentraL "removes pipe and blocks"): usuwanie RUR celowo zostawia
				// structures/blocks in the rack - the finisher would take them for the stuck remnants of QUEUED and remove them.
				// Outside pipe mode, arm the cleanup pass; the game already removes pipes correctly.
				try {
					const sel = sandustryMP.gameApi.action && sandustryMP.gameApi.action.getSelected && sandustryMP.gameApi.action.getSelected(state);
					if (sel && String(sel.id).toLowerCase().indexOf("pipe") >= 0) return false;
				} catch (e) {}
				sandustryMP._hostDemolRect = { x0: Math.floor(Math.min(start.x, end.x)), y0: Math.floor(Math.min(start.y, end.y)), x1: Math.ceil(Math.max(start.x, end.x)), y1: Math.ceil(Math.max(start.y, end.y)), t: performance.now() };
				return false; // the game undresses normally; we'll just clean up after her
			}
			// pipes (Pipe): separate path in the game (Zn) - we forward rect, the host calls _pipeZn (export from patch)
			try {
				const sel = sandustryMP.gameApi.action && sandustryMP.gameApi.action.getSelected && sandustryMP.gameApi.action.getSelected(state);
				if (sel && String(sel.id).toLowerCase().indexOf("pipe") >= 0) {
					net.send({ t: "act", k: "pipeRm", x0: Math.floor(Math.min(start.x, end.x)), y0: Math.floor(Math.min(start.y, end.y)), x1: Math.ceil(Math.max(start.x, end.x)), y1: Math.ceil(Math.max(start.y, end.y)) });
					log("CLIENT pipeRm rect");
					return true; // skip local (host will execute, mirror + snap will confirm)
				}
			} catch (e) {}
			const SA = structNs(); if (!SA) { log("_demol: missing API structures"); return false; }
			// `H(e)` returns a rectangle already expressed in cells; it divides snapped coordinates by `cellSize`.
			// Bug 0.9.28 divided coordinates by four twice, scanning a smaller area near the origin.
			// empty → silent no-op no log ("just nothing happens, no log" - TCentraL).
			const x0 = Math.floor(Math.min(start.x, end.x)), x1 = Math.ceil(Math.max(start.x, end.x));
			const y0 = Math.floor(Math.min(start.y, end.y)), y1 = Math.ceil(Math.max(start.y, end.y));
			if ((x1 - x0 + 1) * (y1 - y0 + 1) > 40000) { log("_demol: rect too large", x0, y0, x1, y1); return false; }
			const found = new Map(); // structKey -> slim
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
				try { const st = SA.getAtCell(state, x, y); if (st) found.set(structKey(st), slimStruct(st)); } catch (e) {}
			}
			if (!found.size) { log("_demol: empty rectangle [" + x0 + "," + y0 + " → " + x1 + "," + y1 + "] — nothing to demolish"); return true; }
			const list = [...found.values()];
			try { net.send({ t: "act", k: "demolish", list, rect: { x0, y0, x1, y1 } }); } catch (e) {}
			log("CLIENT demolish rectangle →", list.length, "structures");
			return true; // skip local (non-working) demolition - confirmation will come via st rm
		} catch (e) { return false; }
	};

	const HOST_ACTION_KINDS = new Set(["dig", "place", "demolish", "upg", "tech", "tier", "story", "collect", "sig", "sbtn", "paste", "sdata", "aug", "pipeRm", "vac", "grabH", "drone", "proj", "move", "pickup", "grabPick", "grabPlace", "fireB", "shakeB", "volcB", "caulkB", "caulkRmB", "cryoB"]);
	function finiteCoordinate(value) { return Number.isFinite(value) && Math.abs(value) <= 1000000; }
	function validCoordinatePair(x, y) { return finiteCoordinate(x) && finiteCoordinate(y); }
	function validCellBatch(cells, maxCells) {
		if (!Array.isArray(cells) || cells.length > maxCells * 2 || cells.length % 2 !== 0) return false;
		for (let index = 0; index < cells.length; index += 2) if (!validCoordinatePair(cells[index], cells[index + 1])) return false;
		return true;
	}
	function validateHostAction(msg, fromId) {
		if (!msg || typeof msg !== "object" || typeof msg.k !== "string" || !HOST_ACTION_KINDS.has(msg.k)) return false;
		// Only a currently connected peer can submit gameplay intent. The packet is
		// still untrusted after this check; every branch must resolve targets from the
		// host world and call a native game operation.
		if (!fromId || !sandustryMP.peers || !sandustryMP.peers.has(fromId)) return false;
		if (["place", "sbtn", "sdata", "grabPick", "grabPlace"].includes(msg.k) && !validCoordinatePair(msg.x, msg.y)) return false;
		if (["vac", "grabH"].includes(msg.k) && !validCoordinatePair(msg.x, msg.y)) return false;
		if (["pipeRm", "demolish"].includes(msg.k)) {
			const rect = msg.k === "demolish" ? msg.rect : msg;
			if (!rect || ![rect.x0, rect.y0, rect.x1, rect.y1].every(finiteCoordinate) || rect.x1 < rect.x0 || rect.y1 < rect.y0 || (rect.x1 - rect.x0 + 1) * (rect.y1 - rect.y0 + 1) > 40000) return false;
		}
		if (["fireB", "shakeB", "volcB", "caulkB", "caulkRmB", "cryoB"].includes(msg.k) && !validCellBatch(msg.c, 1000)) return false;
		if (["paste", "move"].includes(msg.k)) {
			const count = msg.k === "paste" ? (Array.isArray(msg.list) ? msg.list.length : -1) : (Array.isArray(msg.from) && Array.isArray(msg.to) ? msg.from.length + msg.to.length : -1);
			if (count < 0 || count > 1024) return false;
		}
		return true;
	}

	function replayAction(msg, fromId) {
		const state = sandustryMP.state;
		if (!state) return;
		if (!validateHostAction(msg, fromId)) {
			log("HOST rejected invalid or unsupported client action:", msg && msg.k, "from", fromId);
			return;
		}
		try {
			if (msg.k === "dig") {
				const ex = findApi("excavate", ["excavation", "patterns"]); // ns name differs between builds (current=excavation, 0.5.3=patterns)
				if (ex) { ex(state, msg.x, msg.y, msg.m, msg.v, msg.d); if (!sandustryMP._digLogged) { sandustryMP._digLogged = true; log("HOST: first client mining recreated @", msg.x, msg.y); } }
				else if (!sandustryMP._digErrLogged) { sandustryMP._digErrLogged = true; log("ERROR: missing API excavate - FH keys:", Object.keys(sandustryMP.gameApi || {}).join(",")); }
			} else if (msg.k === "set") {
				const sc = findApi("setCellId");
				if (sc) sc(state, msg.x, msg.y, msg.c);
				else log("ERROR: missing API setCellId");
			} else if (msg.k === "place") {
				// The host is authoritative and runs Sandustry's complete native placement validation.
				// Omitting `clearance` makes structures.build calculate it from the current host world,
				// including blocking, replacement, shape, tutorial, and structure-specific restrictions.
				if ((sandustryMP._plRxDiag = (sandustryMP._plRxDiag || 0) + 1) <= 300) log("HOST RX place:", msg.type, "@", msg.x, msg.y, "from", fromId);
				sandustryMP._applyingNet = true;
				let built = null;
				let replaced = null;
				const buildingUnlocked = msg.type != null && canHostPlaceStructure(state, msg.type);
				try {
					if (buildingUnlocked && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
						// Do not pre-remove an occupied structure. Native build owns clearance and
						// replacement validation; a failed request must leave the old structure intact.
						built = buildOne(state, { type: msg.type, x: msg.x, y: msg.y, data: msg.data || undefined, filter: msg.filter || undefined }, false);
					}
				} finally { sandustryMP._applyingNet = false; }
				if (!buildingUnlocked) log("HOST rejected placement of locked building:", msg.type, "from", fromId);
				if (built) {
					const inStore = (state.store.structures || []).indexOf(built) >= 0;
					const structure = slimStruct(built);
					const result = structure.queued || structure.frame ? "partial" : "success";
					net.send({ t: "placeResult", q: Number.isInteger(msg.q) ? msg.q : 0, result, x: msg.x, y: msg.y, structure, replaced }, fromId);
					// The requester constructs only from placeResult. Other clients receive the
					// same already-verified structure through normal replication.
					for (const peerId of sandustryMP.peers.keys()) if (peerId !== fromId) {
						if (replaced) net.send({ t: "st", k: "rm", list: [replaced] }, peerId);
						net.send({ t: "st", k: "add", list: [structure] }, peerId);
					}
					if ((sandustryMP._plDiagH = (sandustryMP._plDiagH || 0) + 1) <= 300) log("HOST placement result:", result, msg.type, "@", built.x, built.y, inStore ? "[in store]" : "[not in store.structures]");
				}
				else {
					net.send({ t: "placeResult", q: Number.isInteger(msg.q) ? msg.q : 0, result: "failure", x: msg.x, y: msg.y, replaced }, fromId);
					if (replaced) for (const peerId of sandustryMP.peers.keys()) if (peerId !== fromId) net.send({ t: "st", k: "rm", list: [replaced] }, peerId);
					if ((sandustryMP._plDiagHE = (sandustryMP._plDiagHE || 0) + 1) <= 300) log("HOST placement result: failure", msg.type, "@", msg.x, msg.y);
				}
			} else if (msg.k === "demolish") {
				// Never trust the client's structure list. Resolve the requested rectangle
				// against the host's live structure geometry, exactly as native selection does.
				const structuresApi = structNs();
				const hostTargets = new Map();
				for (let y = Math.floor(msg.rect.y0); y <= Math.ceil(msg.rect.y1); y++) for (let x = Math.floor(msg.rect.x0); x <= Math.ceil(msg.rect.x1); x++) {
					const structure = structuresApi && structuresApi.getAtCell(state, x, y);
					if (structure) hostTargets.set(structKey(structure), structure);
				}
				const removed = [...hostTargets.values()].map(slimStruct);
				sandustryMP._applyingNet = true;
				try { for (const structure of hostTargets.values()) structuresApi.removeAt(state, structure.x, structure.y, {}); } finally { sandustryMP._applyingNet = false; }
				if (removed.length) net.send({ t: "st", k: "rm", list: removed });
				// Fix (DwoaC): orphan-tile cleanup was armed only for host demolition.
				// The client's demolition left red tiles. Uzbrajamy go bounding-box list (±2).
				if (removed.length) {
					let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
					for (const s of removed) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y; }
					// A new client sends the exact selection rectangle, so it can be cleaned safely.
					// orphaned foundation tiles; the previous code guessed the area from the structure anchors (+2)
					// This previously removed valid foundation tiles beyond the selection. For older clients,
					// we keep the fallback with the bbox, but without cleaning the tiles.
					const r = msg.rect;
					const exact = r && [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 >= r.x0 && r.y1 >= r.y0 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= 40000;
					sandustryMP._hostDemolRect = exact
						? { x0: Math.floor(r.x0), y0: Math.floor(r.y0), x1: Math.ceil(r.x1), y1: Math.ceil(r.y1), t: performance.now(), cleanOrphans: true }
						: { x0: x0, y0: y0, x1: x1 + 2, y1: y1 + 2, t: performance.now(), src: "client" };
				}
			} else if (msg.k === "upg") {
				// customer upgrade purchase (common pool): set level + subtract cost authoritatively
				sandustryMP._applyingNet = true;
				try {
					const u = state.store.upgrades && state.store.upgrades[msg.it] && state.store.upgrades[msg.it][msg.ug];
					if (u) {
						if (typeof msg.lv === "number" && msg.lv > (u.level || 0)) { u.availableLevel = msg.lv; u.level = msg.lv; }
						deductCosts(state, msg.cost);
						try { sandustryMP.gameApi.events.emit(state, "upgrade:purchased", { itemId: msg.it, upgradeId: msg.ug, level: msg.lv }); } catch (e) {}
						log("HOST: client upgrade", msg.it + "." + msg.ug, "→ lvl", msg.lv);
					} else log("HOST: unknown client upgrade:", msg.it, msg.ug);
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "tech") {
				sandustryMP._applyingNet = true;
				let accepted = false;
				try {
					if (state.store.player && state.store.player.tech && !state.store.player.tech[msg.id]) {
						// Run the host's native research path. Besides validating the real technology
						// cost, it removes the matching physical gold from collector cells; directly
						// subtracting store.resources/shared.gold leaves those cells occupied.
						accepted = techUnlock(state, msg.id);
						if (accepted) {
							techSideEffectsFor(state).add(canonicalTechKey(msg.id));
							persistResearchLedger(state);
							try {
								const overlays = sandustryMP.gameApi.ui && sandustryMP.gameApi.ui.overlays;
								if (overlays && overlays.update) {
									overlays.update(state, "management");
									overlays.update(state, "resources");
									overlays.update(state, "global");
								}
							} catch (e) {}
							log("HOST: client technology unlocked through native validation:", msg.id, "stored=" + !!state.store.player.tech[msg.id]);
						} else log("HOST: client technology research rejected by native validation:", msg.id);
					}
				} finally { sandustryMP._applyingNet = false; }
				if (accepted) {
					for (const peerId of sandustryMP.peers.keys()) if (peerId !== fromId) net.send({ t: "tech", id: msg.id }, peerId);
				}
			} else if (msg.k === "tier") {
				const factory = sandustryMP.gameApi.factory;
				const previousLevel = factory && factory.getLevel ? factory.getLevel(state) : 1;
				let acceptedLevel = previousLevel;
				sandustryMP._applyingNet = true;
				try {
					if (factory && factory.canUnlockNextTier && factory.unlockNextTier && factory.canUnlockNextTier(state)) {
						factory.unlockNextTier(state);
						acceptedLevel = factory.getLevel(state);
					}
				} finally { sandustryMP._applyingNet = false; }
				// Reply to every peer, including the requester. If validation failed, the
				// requester's optimistic local tier is rolled back to the host level.
				net.send({ t: "tier", level: acceptedLevel });
				log(acceptedLevel > previousLevel ? "HOST accepted client factory tier unlock:" : "HOST rejected client factory tier unlock; authoritative level", acceptedLevel);
			} else if (msg.k === "story") {
				// client plot step: add to storyProgression.completedSteps (idempotent) + re-emit
				sandustryMP._applyingNet = true;
				try {
					const ens = (sandustryMP.gameApi.storage && sandustryMP.gameApi.storage.ensure) || findApi("ensure", ["storage"]);
					if (ens) {
						const sp = ens(state, "storyProgression");
						const arrS = sp.completedSteps || [];
						if (!arrS.includes(msg.id)) {
							arrS.push(msg.id); sp.completedSteps = arrS;
							try { sandustryMP.gameApi.events.emit(state, "story:stepCompleted", { stepId: msg.id }); } catch (e) {}
							log("HOST: Client Story Step:", msg.id);
						}
					} else log("story ERROR: FH.storage.ensure missing");
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "collect") {
				// critter collection by client: found/available + tickets for PIERWSZE catch (as in the game)
				sandustryMP._applyingNet = true;
				try {
					state.store.creatures = state.store.creatures || {};
					const l = state.store.creatures;
					l[msg.ty] = l[msg.ty] || { available: 0, found: 0 };
					const c = l[msg.ty], first = c.found === 0;
					c.found++; c.available++;
					if (first) {
						state.store.conservatory = state.store.conservatory || { tickets: 0 };
						let types = 0; for (const k in l) if (l[k].found > 0) types++;
						state.store.conservatory.tickets += Math.pow(2, types);
					}
					try { sandustryMP.gameApi.events.emit(state, "entity:collected", { typeId: msg.ty }); } catch (e) {}
					// Remove the entity from the host map. There is no official removal API, so splice the live `getAll` list.
					// Also hide the sprite and disable its light; otherwise the critter remains until a second collection.
					try {
						const EN = sandustryMP.gameApi.entities;
						if (msg.eid != null && EN && EN.getAll) {
							const listE = EN.getAll(state);
							const idxE = listE.findIndex((en) => en && en.id === msg.eid);
							if (idxE >= 0) {
								const en = listE[idxE];
								try { if (en.lightIndex !== undefined && sandustryMP.gameApi.effects && sandustryMP.gameApi.effects.removeLight) { sandustryMP.gameApi.effects.removeLight(state, en.lightIndex); en.lightIndex = undefined; } } catch (e) {}
								try { const spr = EN.getSprite && EN.getSprite(state, en.id); if (spr) { spr.renderable = false; spr.visible = false; } } catch (e) {}
								listE.splice(idxE, 1);
							}
						}
					} catch (e) {}
					log("HOST: client collected critter:", msg.ty, first ? "(FIRST — tickets awarded!)" : "");
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "sig") {
				// client signal changes: execute via FH.signals.link/unlink (authoritative)
				sandustryMP._applyingNet = true;
				try {
					const SG = sandustryMP.gameApi.signals;
					if (SG && SG.link && SG.unlink) {
						for (const c of msg.ch || []) {
							try { if (c.a === "link") SG.link(state, c.f, c.t); else if (c.a === "unlink") SG.unlink(state, c.f, c.t); } catch (e) {}
						}
						try { sandustryMP.gameApi.events.emit(state, "signals:userChanged", { changes: (msg.ch || []).map((c) => ({ action: c.a, from: c.f, to: c.t })) }); } catch (e) {}
						log("HOST: client signals:", (msg.ch || []).length, "changes");
					} else log("ERROR sig: missing FH.signals.link/unlink - keys:", SG ? Object.keys(SG).join(",") : "no ns");
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "sbtn") {
				sandustryMP._applyingNet = true;
				try {
					const SA2 = structNs();
					const stc = SA2 && SA2.getAtCell(state, msg.x, msg.y);
					if (stc) {
						stc.data = Object.assign({}, stc.data || {}, { on: !!msg.on });
						try { if (sandustryMP.gameApi.signals && sandustryMP.gameApi.signals.setAll) sandustryMP.gameApi.signals.setAll(state, { x: msg.x, y: msg.y }, !!msg.on); } catch (e) {}
						try { sandustryMP.gameApi.events.emit(state, "signalButton:pressed", { structure: stc }); } catch (e) {}
						log("HOST: client signal button @", msg.x, msg.y, "→", msg.on);
					}
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "paste") {
				// client blueprint sticker: build everything authoritatively + recreate signal links
				sandustryMP._applyingNet = true;
				try {
					let ok = 0;
					for (const s of msg.list || []) if (buildOne(state, s, true)) ok++;
					if (msg.links && sandustryMP.gameApi.signals && sandustryMP.gameApi.signals.link) {
						for (const l of msg.links) { try { if (l && l.from && l.to) sandustryMP.gameApi.signals.link(state, l.from, l.to); } catch (e) {} }
					}
					net.send({ t: "st", k: "add", list: msg.list });
					log("HOST: client paste -", ok + "/" + (msg.list || []).length, "structures");
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "sdata") {
				// machine configuration changed by the customer (filters/priorities/UI settings)
				sandustryMP._applyingNet = true;
				try {
					const SA3 = structNs();
					const ex = SA3 && SA3.getAtCell(state, msg.x, msg.y);
					if (ex && ex.type === msg.type) {
						ex.data = msg.data;
						if (SA3.update) SA3.update(state, ex, { propagateToWorkers: true });
						log("HOST: machine config from the client:", msg.type, "@", msg.x, msg.y);
					}
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "aug") {
				// client's choice of augment: the host takes over the entire object (nodes/pendingChoice/sockets);
				// stream mods will spread the state to everyone (closes the overlay also on the client)
				sandustryMP._applyingNet = true;
				try {
					if (msg.a && typeof msg.a === "object") {
						state.store.mods = state.store.mods || {};
						state.store.mods.augments = Object.assign(state.store.mods.augments || {}, msg.a);
						try { sandustryMP.gameApi.ui && sandustryMP.gameApi.ui.overlays && sandustryMP.gameApi.ui.overlays.update && sandustryMP.gameApi.ui.overlays.update(state, "global"); } catch (e) {}
						log("HOST: client augments applied (select from augment screen)");
					}
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "pipeRm") {
				// Client pipe demolition calls the real game function (`Zn` exported from the demolition module patch).
				sandustryMP._applyingNet = true;
				try {
					if (typeof sandustryMP._pipeZn === "function") { sandustryMP._pipeZn(state, { x: msg.x0, y: msg.y0 }, { x: msg.x1, y: msg.y1 }); log("HOST: client pipes dismantled within the rectangle"); }
					else log("pipeRm ERROR: _pipeZn missing (patch 'demolish module exports' not applied?)");
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "vac") {
				hostHarvestVacuum(msg, fromId);
			} else if (msg.k === "grabH") {
				hostHarvestGrab(msg, fromId);
			} else if (msg.k === "drone") {
				// the client has deployed the drone → add authoritatively to the host's store.drones (its sim will handle it)
				const d = msg.d;
				if (d && d.id != null) {
					const arr = state.store.drones || (state.store.drones = []);
					// Client and host have independent `nextId` counters; assign a free ID instead of silently dropping collisions.
					if (arr.some((x) => x && x.id === d.id)) {
						let mx = 0; for (const x of arr) if (x && x.id > mx) mx = x.id;
						d.id = mx + 1;
					}
					arr.push(d);
					if ((sandustryMP._drHDiag = (sandustryMP._drHDiag || 0) + 1) <= 20) log("HOST: client drone added", d.type, "@", d.x, d.y, "id=" + d.id, "(drones=" + arr.length + ")");
				}
			} else if (msg.k === "proj") {
				// client fired the gun → add a missile to the host's store.projectiles → his sim simulates flight + explosion
				const p = msg.p;
				if (p) { const arr = state.store.projectiles || (state.store.projectiles = []); arr.push(p); if ((sandustryMP._prHDiag = (sandustryMP._prHDiag || 0) + 1) <= 20) log("HOST: client missile added", p.type, "@", Math.round(p.x), Math.round(p.y), "(proj=" + arr.length + ")"); }
			} else if (msg.k === "move") {
				sandustryMP._applyingNet = true;
				try { for (const s of msg.from) removeOne(state, s); for (const s of msg.to) buildOne(state, s); } finally { sandustryMP._applyingNet = false; }
				net.send({ t: "st", k: "mv", from: msg.from, to: msg.to });
			} else if (msg.k === "pickup") {
				const items = (sandustryMP.gameApi.world && sandustryMP.gameApi.world.items) || deepFindNs("items", "pickUp");
				const item = items && items.getById ? items.getById(state, msg.id) : (state.store.worldItems || []).find((i) => i.id === msg.id);
				if (item && items && items.pickUp) { sandustryMP._applyingNet = true; try { items.pickUp(state, item); } finally { sandustryMP._applyingNet = false; } }
				else if (item) state.store.worldItems = state.store.worldItems.filter((i) => i.id !== msg.id);
			} else if (msg.k === "grabPick") {
				const { cellIds: gsim, width: gW, height: gH } = worldBuffers(state);
				const gsim32 = gsim && gW ? new Uint32Array(gsim.buffer, gsim.byteOffset, gW * gH) : null;
				const gidx = gsim32 && msg.x >= 0 && msg.y >= 0 && msg.x < gW && msg.y < gH ? msg.x + msg.y * gW : -1;
				const gbefore = gidx >= 0 ? gsim32[gidx] : -1;
				sandustryMP._applyingNet = true;
				try { if (sandustryMP.gameApi.elements && sandustryMP.gameApi.elements.removeAt) sandustryMP.gameApi.elements.removeAt(state, msg.x, msg.y); } finally { sandustryMP._applyingNet = false; } markCellDirty(state, msg.x, msg.y);
				const gafter = gidx >= 0 ? gsim32[gidx] : -1;
				if ((sandustryMP._grabPickHostDiag = (sandustryMP._grabPickHostDiag || 0) + 1) <= 60)
					log("HOST grabPick @", msg.x, msg.y, "before=" + gbefore, "after=" + gafter, gbefore >= ELEMENTS_MIN && gafter === 0 ? "[removed]" : gafter === gbefore ? "[removeAt changed nothing]" : "[after=" + gafter + "]");
			} else if (msg.k === "grabPlace") {
				if (!validElement(msg.et)) return; // protection against old client (≤0.9.8) with et=null → createAt crash
				sandustryMP._applyingNet = true;
				try {
					const { cellIds: sim, width: W, height: H } = worldBuffers(state);
					const sim32 = sim && W ? new Uint32Array(sim.buffer, sim.byteOffset, W * H) : null;
					const inb = sim32 && msg.x >= 0 && msg.y >= 0 && msg.x < W && msg.y < H;
					const before = inb ? sim32[msg.x + msg.y * W] : -1;
					if (sandustryMP.gameApi.elements && sandustryMP.gameApi.elements.createAt) sandustryMP.gameApi.elements.createAt(state, msg.x, msg.y, msg.et);
					markCellDirty(state, msg.x, msg.y); // force the chunk to be sent via mirror → the client gets the set aside item (re-grab)
					const after = inb ? sim32[msg.x + msg.y * W] : -1;
					// Diagnose whether `createAt` placed a real element; otherwise report why re-grab cannot be enabled.
					if ((sandustryMP._grabPlaceHostDiag = (sandustryMP._grabPlaceHostDiag || 0) + 1) <= 60)
						log("HOST grabPlace @", msg.x, msg.y, "et=" + msg.et, "before=" + before, "after=" + after, (after >= ELEMENTS_MIN && after <= ELEMENTS_MAX) ? "[placed]" : "[nothing after createAt; lost or occupied]");
					// REFUND (R5 closure): vanilla returns the element to the tank when the cell turned out to be busy -
					// at the client, refund-callback (Lu) never works, so the host sends the refund back explicitly.
					const placed = after >= ELEMENTS_MIN && after <= ELEMENTS_MAX && after !== before;
					if (!placed) try { net.send({ t: "grabRef", et: msg.et }, fromId); } catch (e) {}
				} finally { sandustryMP._applyingNet = false; }
			} else if (msg.k === "fireB") {
				// MITYGACJA (Knight-HD: "customer's flamethrower makes holes in foundations/pyramid"):
				// old replay burned EVERY cell (burnElementAt+createAt) without vanilla guards,
				// destroying TEREN. Teraz: terrain (cellId 1..1000) = NIETYKALNY; empty (0) = flame only;
				// element = only burnElementAt (ignites combustibles). Knight is working on a full fix - welcome.
				const el = sandustryMP.gameApi.elements, fi = sandustryMP.gameApi.fire, c = msg.c || [];
				const shF = state.shared, simF = shF && shF.sim && shF.sim.cellIds;
				const simF32 = simF ? new Uint32Array(simF.buffer, simF.byteOffset, simF.length) : null;
				const WF = (shF && shF.mapData && shF.mapData.width) || 0;
				sandustryMP._applyingNet = true;
				try {
					for (let i = 0; i + 1 < c.length; i += 2) {
						const x = c[i], y = c[i + 1];
						const cid = simF32 && WF ? simF32[x + y * WF] : 0;
						if (cid > 0 && cid < ELEMENTS_MIN) continue; // TEREN (foundations, rocks, pyramid) - we do not touch
						if (cid === 0) { try { if (el && el.createAt) el.createAt(state, x, y, RJ_FIRE); } catch (e) {} } // empty air → flame
						else { try { if (fi && fi.burnElementAt) fi.burnElementAt(state, x, y); } catch (e) {} } // element → ignite (combustibles will ignite, the rest remains)
					}
				} finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._fireLogged) { sandustryMP._fireLogged = true; log("HOST: client fire recreated (with area protection),", c.length / 2, "cells"); }
			} else if (msg.k === "shakeB") {
				// client shake: residue to world (empty cells only) + process counter ShakeWetSand
				const elS = sandustryMP.gameApi.elements, cS = msg.c || [];
				sandustryMP._applyingNet = true;
				try {
					for (let i = 0; i + 1 < cS.length; i += 2) {
						try { if (sandustryMP.gameApi.factory && sandustryMP.gameApi.factory.recordProcess) sandustryMP.gameApi.factory.recordProcess(state, 0 /* ShakeWetSand */); } catch (e) {}
						try { if (sandustryMP.gameApi.world && sandustryMP.gameApi.world.isCellEmpty && sandustryMP.gameApi.world.isCellEmpty(state, cS[i], cS[i + 1]) && elS && elS.createAt) elS.createAt(state, cS[i], cS[i + 1], 6 /* RJ.Residue */); } catch (e) {}
					}
				} finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._shakeLogged) { sandustryMP._shakeLogged = true; log("HOST: client shake recreated (residue+process),", cS.length / 2, "slots"); }
			} else if (msg.k === "volcB") {
				// Client volcanizer lava enters empty cells only, matching vanilla `isCellEmpty` behavior.
				const elV = sandustryMP.gameApi.elements, cV = msg.c || [];
				sandustryMP._applyingNet = true;
				try { for (let i = 0; i + 1 < cV.length; i += 2) { try { if (sandustryMP.gameApi.world && sandustryMP.gameApi.world.isCellEmpty && sandustryMP.gameApi.world.isCellEmpty(state, cV[i], cV[i + 1]) && elV && elV.createAt) elV.createAt(state, cV[i], cV[i + 1], 19 /* RJ.Lava */); } catch (e) {} } } finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._volcLogged) { sandustryMP._volcLogged = true; log("HOST: client lava recreated,", cV.length / 2, "cells"); }
			} else if (msg.k === "caulkB") {
				// caulku spray: dynamically resolved element type (mod-element, runtime id); just empty cells
				const elC = sandustryMP.gameApi.elements, cC = msg.c || [];
				let caulkTy = null;
				try { caulkTy = elC && elC.getElementTypeFromId && elC.getElementTypeFromId(state, "caulk"); } catch (e) {}
				sandustryMP._applyingNet = true;
				try { if (caulkTy != null) for (let i = 0; i + 1 < cC.length; i += 2) { try { if (sandustryMP.gameApi.world && sandustryMP.gameApi.world.isCellEmpty && sandustryMP.gameApi.world.isCellEmpty(state, cC[i], cC[i + 1]) && elC.createAt) elC.createAt(state, cC[i], cC[i + 1], caulkTy); } catch (e) {} } } finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._caulkLogged) { sandustryMP._caulkLogged = true; log("HOST: client caulk restored,", cC.length / 2, "cells (type=" + caulkTy + ")"); }
			} else if (msg.k === "caulkRmB") {
				// Caulk removal mirrors game logic: remove caulk elements and affect terrain only when permitted.
				// isPosTerrainId 'solidite' → terrains.removeAt. No other land is touched.
				const elR = sandustryMP.gameApi.elements, trR = sandustryMP.gameApi.terrains, cR = msg.c || [];
				let caulkTy2 = null;
				try { caulkTy2 = elR && elR.getElementTypeFromId && elR.getElementTypeFromId(state, "caulk"); } catch (e) {}
				sandustryMP._applyingNet = true;
				try {
					for (let i = 0; i + 1 < cR.length; i += 2) {
						const x = cR[i], y = cR[i + 1];
						try {
							const ty = elR && elR.getResolvedTypeAtPos && elR.getResolvedTypeAtPos(state, x, y);
							if (caulkTy2 != null && ty === caulkTy2) { if (elR.removeAt) elR.removeAt(state, x, y); }
							else if (trR && trR.isPosTerrainId && trR.isPosTerrainId(state, x, y, "solidite") && trR.removeAt) trR.removeAt(state, x, y);
						} catch (e) {}
					}
				} finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._caulkRmLogged) { sandustryMP._caulkRmLogged = true; log("HOST: client cache delete restored,", cR.length / 2, "cells"); }
			} else if (msg.k === "cryoB") {
				const el = sandustryMP.gameApi.elements, c = msg.c || [];
				sandustryMP._applyingNet = true;
				try { for (let i = 0; i + 1 < c.length; i += 2) { try { if (el && el.createAt) el.createAt(state, c[i], c[i + 1], RJ_FREEZINGICE); } catch (e) {} } } finally { sandustryMP._applyingNet = false; }
				if (!sandustryMP._cryoLogged) { sandustryMP._cryoLogged = true; log("HOST: client ice restored,", c.length / 2, "cells"); }
			}
		} catch (e) { log("replay error:", msg.k, e.message); }
	}

	// looks for a nested namespace in FH (e.g. world.items) after the function name
	function deepFindNs(nsName, fnName) {
		const gameApi = sandustryMP.gameApi;
		if (!gameApi) return null;
		for (const key of Object.keys(gameApi)) {
			try {
				const ns = gameApi[key] && gameApi[key][nsName];
				if (ns && typeof ns[fnName] === "function") return ns;
			} catch (e) {}
		}
		return null;
	}

	// ------------------------------------------------------------------
	// HUD
	// ------------------------------------------------------------------
	const showInviteButton = (show) => {
		if (sandustryMP._hud) sandustryMP._hud.querySelector("#smp-invite").style.display = show ? "inline-block" : "none";
	};
	function updateLobbyIdDisplay() {
		if (!sandustryMP._hud) return;
		const el = sandustryMP._hud.querySelector("#smp-lobbyid");
		if (!el) return;
		// STREAMER-SAFE (MFeltmann): ID masked on screen - click copies FULL ID to clipboard
		// without showing it (stream viewers will not enter the preview lobby).
		if (sandustryMP.net.lobbyId) { el.textContent = "Lobby ID: ●●●●●●…" + String(sandustryMP.net.lobbyId).slice(-3) + " 📋 (click = copy)"; el.style.display = "block"; }
		else el.style.display = "none";
	}
	function updatePingDisplay() {
		if (!sandustryMP._hud) return;
		const el = sandustryMP._hud.querySelector("#smp-ping");
		if (!el) return;
		if (!sandustryMP.peers.size) { el.textContent = ""; return; }
		const parts = [];
		for (const p of sandustryMP.peers.values()) parts.push((p.nick || "Player") + ": " + (p.ping != null ? p.ping + "ms" : "…"));
		el.textContent = "Ping — " + parts.join("  |  ");
	}

	function buildHud() {
		if (sandustryMP._hud) return;
		const hud = document.createElement("div");
		hud.id = "smp-hud";
		hud.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;background:rgba(10,10,14,.85);color:#ddd;font:12px monospace;padding:8px 10px;border:1px solid #444;border-radius:6px;user-select:none;min-width:210px";
		hud.innerHTML =
			'<div id="smp-head" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px">' +
			'<span id="smp-title-full" style="font-weight:bold;color:#ffb454">SandustryMP <span style="color:#666">' + VER + '</span> <span style="color:#555;font-size:9px">' + t("by") + "</span></span>" +
			// collapsed panel = small pill "sandustryMP ●" with a dot in the status color (feedback TCentraL: "wish I could hide it")
			'<span id="smp-title-mini" style="display:none;font-weight:bold;color:#ffb454">sandustryMP <span id="smp-mini-dot" style="color:#f66">●</span></span>' +
			'<span id="smp-collapse" style="color:#888;font-size:14px;line-height:1">▾</span>' +
			"</div>" +
			'<div id="smp-body">' +
			// BADGE ROLI: always visible, colorful "am I hosting / am I connected" (user feedback:
			// "it doesn't write there whether it hosts the game or not")
			'<div id="smp-badge" style="margin:4px 0 2px;font-weight:bold;font-size:12px;color:#f66">' + t("badge_offline") + "</div>" +
			'<div id="smp-status" style="margin:2px 0;color:#aaa">' + t("offline") + "</div>" +
			'<div id="smp-sync" style="margin:2px 0;color:#7af;font-size:10px"></div>' +
			'<div id="smp-ping" style="margin:2px 0;color:#fc7;font-size:10px"></div>' +
			'<div id="smp-lobbyid" style="margin:2px 0;color:#9f9;font-size:10px;display:none"></div>' +
			// LISTA GRACZY: who is in the session (nickname + mod version compatibility)
			'<div id="smp-players" style="margin:3px 0;display:none;font-size:11px;line-height:1.5"></div>' +
			// Session controls; hosting and joining live in the main Multiplayer lobby.
			'<div id="smp-buttons" style="display:flex;flex-wrap:wrap;gap:1px">' +
			'<button id="smp-invite" style="display:none">' + t("btn_invite") + "</button>" +
			'<button id="smp-stop">' + t("btn_stop") + "</button>" +
			'<button id="smp-send-world">' + t("btn_send_world") + "</button>" +
			'<button id="smp-resync">' + t("btn_resync") + "</button>" +
			// team chat (host relays between clients)
			'<div id="smp-chat-log" style="margin-top:4px;max-height:72px;overflow:hidden;font-size:10px;color:#cde;line-height:1.35"></div>' +
			'<div id="smp-chat-row" style="margin-top:2px">' +
			'<input id="smp-chat-in" placeholder="' + t("chat_ph") + '" maxlength="200" spellcheck="false" ' +
			'style="width:150px;background:#111;color:#ddd;border:1px solid #555;border-radius:3px;font:11px monospace;padding:2px 4px"> ' +
			'<button id="smp-chat-send">➤</button>' +
			"</div>" +
			"</div>" +
			'<div id="smp-hint" style="margin-top:4px;color:#666;font-size:10px">' + t("hint") + "</div>" +
			"</div>";
		document.body.appendChild(hud);
		for (const b of hud.querySelectorAll("button")) b.style.cssText = "background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font:11px monospace;cursor:pointer;margin:1px;padding:2px 6px";
		updatePanel(); setInterval(updatePanel, 1000); // badge/przyciski/gracze zawsze aktualne
		hud.querySelector("#smp-invite").onclick = () => net.invite();
		// CZAT: Enterem/button send; keys do not leak into the game (like LAN box)
		const chatIn = hud.querySelector("#smp-chat-in");
		const chatSend = () => {
			const m = (chatIn.value || "").trim();
			if (!m || sandustryMP.net.role === "idle") return;
			chatIn.value = "";
			try { net.send({ t: "chat", m }); } catch (e) {}
			addChat(t("chat_me"), m);
		};
		hud.querySelector("#smp-chat-send").onclick = chatSend;
		chatIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); chatSend(); } });
		chatIn.addEventListener("keyup", (e) => e.stopPropagation());
		hud.querySelector("#smp-stop").onclick = () => { setClientPaused(false); net.stop(); };
		hud.querySelector("#smp-send-world").onclick = sendWorld;
		hud.querySelector("#smp-resync").onclick = () => net.send({ t: "resync" });
		const lobbyEl = hud.querySelector("#smp-lobbyid");
		lobbyEl.style.cursor = "pointer"; lobbyEl.title = "Click to copy";
		lobbyEl.onclick = async () => {
			if (!sandustryMP.net.lobbyId) return;
			try { await navigator.clipboard.writeText(sandustryMP.net.lobbyId); lobbyEl.textContent = t("lobby_copied"); setTimeout(updateLobbyIdDisplay, 900); }
			catch (e) { log("clipboard copy error:", e.message); }
		};
		// Collapse and expand by clicking the header; avoid game keys because F9 conflicts with quick-load.
		let collapsed = false;
		const body = hud.querySelector("#smp-body");
		const arrow = hud.querySelector("#smp-collapse");
		const setCollapsed = (c) => {
			collapsed = c; body.style.display = c ? "none" : "block"; arrow.textContent = c ? "▸" : "▾";
			// mini-pill: the collapsed panel occupies ~40px instead of the full width of the header
			const full = hud.querySelector("#smp-title-full"), mini = hud.querySelector("#smp-title-mini");
			if (full) full.style.display = c ? "none" : "";
			if (mini) mini.style.display = c ? "" : "none";
			hud.style.minWidth = c ? "0" : "210px";
			hud.style.padding = c ? "3px 8px" : "8px 10px";
		};
		hud.querySelector("#smp-head").onclick = () => setCollapsed(!collapsed);
		// Capture and block the safe Ctrl+Shift+H shortcut so it never reaches the game.
		window.addEventListener("keydown", (e) => {
			if (e.ctrlKey && e.shiftKey && e.code === "KeyH") { e.preventDefault(); e.stopImmediatePropagation(); setCollapsed(!collapsed); }
		}, true);
		sandustryMP._hud = hud;
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildHud);
	else buildHud();

	// Backstop: if after 12 seconds the game save has still not been captured,
	// means that the critical hook (frame:update) did not work → unsupported game version.
	setTimeout(() => {
		if (!sandustryMP.state) {
			log("BACKSTOP: no game save after 12 seconds - frame hook does not work (unsupported version?)");
			if (sandustryMP._hud) { setStatus(t("unsupported"), "#f66"); }
		}
	}, 12000);

	// ------------------------------------------------------------------
	// Transfer save (common starting map)
	// ------------------------------------------------------------------
	function getLastPlayedGame() {
		try {
			if (typeof window.electron.getLastPlayedGameSync !== "function") return null;
			const value = window.electron.getLastPlayedGameSync();
			return typeof value === "string" ? JSON.parse(value) : value;
		}
		catch (e) { log("Could not read the previous Continue save:", e.message); return null; }
	}

	async function restoreLastPlayedGame(previousLastPlayed, temporarySaveId) {
		try {
			const currentLastPlayed = getLastPlayedGame();
			if (currentLastPlayed && currentLastPlayed.id && currentLastPlayed.id !== temporarySaveId) return;
			if (previousLastPlayed && previousLastPlayed.id && typeof window.electron.saveLastPlayedGame === "function") await window.electron.saveLastPlayedGame(previousLastPlayed);
			else if (typeof window.electron.clearLastPlayedGame === "function") await window.electron.clearLastPlayedGame();
		} catch (e) { log("Could not restore the previous Continue save:", e.message); }
	}

	async function removeTransferSave(saveId, previousLastPlayed) {
		try {
			if (saveId && typeof window.electron.deleteSave === "function") await window.electron.deleteSave(saveId);
			log("Removed temporary world-transfer save:", saveId);
		} catch (e) { log("Could not remove temporary world-transfer save:", saveId, e.message); }
		await restoreLastPlayedGame(previousLastPlayed, saveId);
	}

	function createTransferSave(state, saveName) {
		return new Promise((resolve, reject) => {
			const game = sandustryMP.gameApi && sandustryMP.gameApi.game;
			if (!game || typeof game.save !== "function") { reject(new Error("native game.save is unavailable")); return; }
			let settled = false;
			const timeout = setTimeout(() => complete(reject, new Error("native transfer save timed out")), 120000);
			const complete = (callback, value) => { if (settled) return; settled = true; clearTimeout(timeout); callback(value); };
			try {
				// FH.game.save is positional: (state, name, existingSaveId). It returns the
				// generated id, while the underlying save record carries the callbacks.
				const saveId = game.save(state, saveName);
				const saving = state.session && state.session.saving;
				if (!saveId || !saving || saving.id !== saveId) {
					complete(reject, new Error("native game.save rejected the transfer snapshot"));
					return;
				}
				saving.onComplete = () => complete(resolve, saveId);
				saving.onError = (error) => complete(reject, error instanceof Error ? error : new Error(String(error || "native save failed")));
			} catch (e) { complete(reject, e); }
		});
	}

	async function findTransferSave(saveName) {
		const saves = await window.electron.getSaveFiles();
		if (!Array.isArray(saves)) return null;
		return saves.find((save) => save && save.name === saveName) || null;
	}

	async function sendWorld() {
		if (sandustryMP._creatingWorldTransfer) { log("sendWorld skipped because a transfer snapshot is already being created"); return; }
		sandustryMP._creatingWorldTransfer = true;
		try {
			if (sandustryMP.net.role === "idle") { setStatus(t("connect_first"), "#f66"); return; }
			// HOST In MENU (report TCentraL: Steam-join before the host loaded the map → the client loaded
			// speculative "last save" over and over again): we send the world only when the FAKTYCZNIE host is in it -
			// Auto-send runs after entering a world. Until then, clients receive `world-wait` without consuming request retries.
			// Do not begin another transfer while one is active; interleaving transfer packets corrupts the save.
			// transfers = corrupt save on client (fix derErste67)
			if (sandustryMP._wtx && sandustryMP._wtx.queue && sandustryMP._wtx.queue.length) {
				log("sendWorld skipped because the previous transfer still has " + sandustryMP._wtx.queue.length + " packets queued");
				return;
			}
			const hostScene = sandustryMP.state && sandustryMP.state.store && sandustryMP.state.store.scene && sandustryMP.state.store.scene.active;
			if (hostScene == null || hostScene === 1) {
				setStatus(t("host_enter_world_first"), "#fd5");
				log("sendWorld paused - host in menu; I'm sending world-wait");
				try { net.send({ t: "world-wait" }); } catch (e) {}
				return;
			}
			const transferToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
			const saveName = "SandustryMP session transfer " + transferToken;
			const previousLastPlayed = getLastPlayedGame();
			setStatus(t("exporting", saveName), "#ff5");
			const exportStartedAt = performance.now();
			let exportResult;
			let saveId = null;
			try {
				await createTransferSave(sandustryMP.state, saveName);
				const transferSave = await findTransferSave(saveName);
				if (!transferSave || !transferSave.id) throw new Error("native transfer save completed but its generated id was not found");
				saveId = transferSave.id;
				exportResult = await window.electron.exportSave(saveId);
			} finally {
				if (!saveId) {
					try { const transferSave = await findTransferSave(saveName); saveId = transferSave && transferSave.id; } catch (e) {}
					if (!saveId) {
						const currentLastPlayed = getLastPlayedGame();
						if (currentLastPlayed && currentLastPlayed.name === saveName) saveId = currentLastPlayed.id;
					}
				}
				if (saveId) await removeTransferSave(saveId, previousLastPlayed);
				else await restoreLastPlayedGame(previousLastPlayed, null);
			}
			if (!exportResult || !exportResult.success) { setStatus(t("export_err", exportResult && exportResult.error), "#f66"); log("sendWorld: exportSave FAILED:", exportResult && exportResult.error); return; }
			log("sendWorld: created and exported current session snapshot in", Math.round(performance.now() - exportStartedAt), "ms");
			const bytes = new Uint8Array(exportResult.data.data || exportResult.data);
			const encodedSave = encodeBase64(bytes);
			const partSize = 49152; // 48KB/package - safely under Steam P2P limits
			const totalParts = Math.ceil(encodedSave.length / partSize);
			const parts = new Array(totalParts);
			for (let partIndex = 0; partIndex < totalParts; partIndex++) parts[partIndex] = encodedSave.substr(partIndex * partSize, partSize);
			// queue for staggered shipment (not blast) + remembered for retry.
			// tid = transfer id (fix derErste67 "yellow half world"): packages of TWO transfers
			// were intertwined in one reception → the client combined saves from two versions of the world (autosave
			// host between sends!) and loaded the ZEPSUTY world. Teraz customer only accepts parcels
			// current tid, and the host does not start a new transfer while the previous one is in progress (guard above).
			sandustryMP._wtxSeq = (sandustryMP._wtxSeq || 0) + 1;
			sandustryMP._wtx = { tid: sandustryMP._wtxSeq, saveId, name: saveName, parts, total: totalParts, queue: [], sent: 0, sizeKB: Math.round(bytes.length / 1024) };
			for (let partIndex = 0; partIndex < totalParts; partIndex++) sandustryMP._wtx.queue.push(partIndex);
			net.send({ t: "world-begin", tid: sandustryMP._wtx.tid, saveId: sandustryMP._wtx.saveId, name: sandustryMP._wtx.name, size: bytes.length, chunks: totalParts });
			sandustryMP._pendingWorldSend = false;
			sandustryMP._autoSentWid = (sandustryMP.state.store.meta && sandustryMP.state.store.meta.worldId) || "unknown";
			setStatus(t("world_sent", sandustryMP._wtx.sizeKB, totalParts), "#5f5");
			pumpWtx();
		} catch (e) { setStatus(t("export_err", e.message), "#f66"); log("sendWorld error:", e); }
		finally { sandustryMP._creatingWorldTransfer = false; }
	}

	// sends pieces in packets of several, with breaks - Steam P2P does not lose packets when the buffer is not full
	function pumpWtx() {
		const worldTransfer = sandustryMP._wtx;
		if (!worldTransfer) return;
		if (sandustryMP._wtxTimer) return; // It's already pumping
		const step = () => {
			if (!sandustryMP._wtx) { sandustryMP._wtxTimer = null; return; }
			const activeTransfer = sandustryMP._wtx;
			let sentParts = 0;
			while (activeTransfer.queue.length && sentParts < 4) { // four packages per tick
				const partIndex = activeTransfer.queue.shift();
				net.send({ t: "world-chunk", tid: activeTransfer.tid, i: partIndex, data: activeTransfer.parts[partIndex] });
				activeTransfer.sent++; sentParts++;
			}
			if (activeTransfer.queue.length) { sandustryMP._wtxTimer = setTimeout(step, 25); }
			else { net.send({ t: "world-end", tid: activeTransfer.tid }); sandustryMP._wtxTimer = null; }
		};
		sandustryMP._wtxTimer = setTimeout(step, 0);
	}

	// ------------------------------------------------------------------
	// Panel: badge roli + kontekstowe przyciski + lista graczy.
	// Session state must be visible at a glance; users reported that the overlay did not show
	// no information, I do not write or host").
	// ------------------------------------------------------------------
	function updatePanel() {
		const hud = document.getElementById("smp-hud"); if (!hud) return;
		const q = (id) => hud.querySelector(id);
		const role = sandustryMP.net.role;
		const trName = sandustryMP.net.transport === "steam" ? "Steam" : "LAN";
		const badge = q("#smp-badge");
		const roleColor = role === "host" ? "#5f5" : role === "client" ? "#6cf" : "#f66";
		if (badge) {
			if (role === "host") { badge.textContent = t("badge_host", trName); badge.style.color = roleColor; }
			else if (role === "client") { badge.textContent = t("badge_client", trName); badge.style.color = roleColor; }
			else { badge.textContent = t("badge_offline"); badge.style.color = roleColor; }
		}
		const miniDot = q("#smp-mini-dot");
		if (miniDot) miniDot.style.color = roleColor; // status dot too on a rolled up mini pill
		const show = (id, on) => { const el = q(id); if (el) el.style.display = on ? "" : "none"; };
		show("#smp-invite", role === "host" && sandustryMP.net.transport === "steam");
		show("#smp-send-world", role === "host");
		show("#smp-resync", role === "client");
		show("#smp-stop", role !== "idle");
		const pl = q("#smp-players");
		if (pl) {
			if (role === "idle") { pl.style.display = "none"; pl.innerHTML = ""; }
			else {
				pl.style.display = "";
				pl.innerHTML = "";
				const mk = (dotColor, nick, info) => {
					const r = document.createElement("div");
					const d = document.createElement("span"); d.textContent = "● "; d.style.color = dotColor;
					const n = document.createElement("span"); n.textContent = nick; n.style.color = "#fff";
					const i = document.createElement("span"); i.textContent = info ? "  " + info : ""; i.style.color = "#889";
					r.appendChild(d); r.appendChild(n); r.appendChild(i);
					pl.appendChild(r);
				};
				mk("#5f5", sandustryMP._myNick || "Player", "(" + t("lb_you") + (role === "host" ? " · host)" : ")"));
				for (const [, pr] of sandustryMP.peers) {
					const ok = !pr.modVer || pr.modVer === VER;
					mk(ok ? "#5f5" : "#f66", pr.nick || "?", ok ? "" : pr.modVer);
				}
			}
		}
	}

	const menuModule = window.SandustryMPMenu && window.SandustryMPMenu.create({ sandustryMP, t, net, setStatus, log, setClientPaused, VER });
	if (!menuModule) throw new Error("SandustryMP menu module was not loaded");
	const ensureMenuUi = menuModule.ensureMenuUi;
	const renderLobby = menuModule.renderLobby;

	// ------------------------------------------------------------------
	// Duszki
	// ------------------------------------------------------------------
	function ensureGhostCanvas() {
		const game = document.getElementById("canvas");
		if (!game) return null;
		let gc = sandustryMP._ghostCanvas;
		if (!gc) {
			gc = document.createElement("canvas");
			gc.id = "smp-ghosts";
			gc.style.cssText = "position:absolute;pointer-events:none;z-index:5000";
			game.parentElement.appendChild(gc);
			sandustryMP._ghostCanvas = gc;
		}
		const r = game.getBoundingClientRect();
		if (gc.width !== game.width || gc.height !== game.height) { gc.width = game.width; gc.height = game.height; }
		gc.style.left = r.left + "px"; gc.style.top = r.top + "px";
		gc.style.width = r.width + "px"; gc.style.height = r.height + "px";
		return gc;
	}

	// --- per-player colors + off-screen player arrow (dotNine contribution) ---
	const PEER_PALETTE = [
		{ body: "#4fc3f7", dark: "#01579b" },
		{ body: "#ff8a65", dark: "#bf360c" },
		{ body: "#ba68c8", dark: "#4a148c" },
		{ body: "#aed581", dark: "#33691e" },
		{ body: "#ffd54f", dark: "#e65100" },
	];
	function peerColor(id) {
		let h = 0;
		for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
		return PEER_PALETTE[h % PEER_PALETTE.length];
	}
	const EDGE_INDICATOR_MARGIN = 40;
	function drawOffscreenIndicator(ctx, gc, screen, color, label) {
		const cx = gc.width / 2, cy = gc.height / 2;
		const dx = screen.x - cx, dy = screen.y - cy;
		if (!dx && !dy) return;
		const halfW = gc.width / 2 - EDGE_INDICATOR_MARGIN, halfH = gc.height / 2 - EDGE_INDICATOR_MARGIN;
		const scale = Math.min(Math.abs(halfW / (dx || 1e-6)), Math.abs(halfH / (dy || 1e-6)));
		const ex = Math.max(26, Math.min(gc.width - 26, cx + dx * scale));
		const ey = Math.max(26, Math.min(gc.height - 26, cy + dy * scale));
		const angle = Math.atan2(dy, dx);
		ctx.save();
		ctx.translate(ex, ey); ctx.rotate(angle);
		ctx.fillStyle = color.body; ctx.strokeStyle = color.dark; ctx.lineWidth = 2.5;
		ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(-13, -14); ctx.lineTo(-13, 14); ctx.closePath();
		ctx.fill(); ctx.stroke();
		ctx.restore();
		ctx.font = "bold 11px monospace"; ctx.textAlign = "center";
		ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(0,0,0,.9)"; ctx.lineWidth = 3.5;
		const ly = ey + (dy < 0 ? -24 : 30);
		ctx.strokeText(label, ex, ly); ctx.fillText(label, ex, ly);
	}

	// --- Modele players: real sprites cloned from the game engine (dotNine contribution) ---
	const NAMETAG_OFFSET_PX = 46;
	const PUPPET_ANCHOR_DX = 6, PUPPET_ANCHOR_DY = 13; // anchor correction relative to store.player.x/y (for tuning)
	const PUPPET_PART_ORDER = ["body", "weapon", "builder", "buildTool", "cryoblaster", "vacuum", "forearm", "shovel", "flamethrower", "rocketLauncher", "offhandShovel"];
	const PUPPET_ALWAYS_PARTS = new Set(["body", "forearm"]);
	const PUPPET_TOOL_PARTS = PUPPET_PART_ORDER.filter((n) => !PUPPET_ALWAYS_PARTS.has(n));
	const MUZZLE_FLASH_MS = 90;
	const AIM_PART_NAMES = new Set(PUPPET_TOOL_PARTS);
	function cloneSpriteObj(src) {
		try {
			if (!src || !src.texture) return null;
			const clone = new src.constructor(src.texture);
			clone.anchor.copyFrom(src.anchor); clone.scale.copyFrom(src.scale);
			clone.x = src.x; clone.y = src.y; clone.rotation = src.rotation; clone.alpha = src.alpha;
			return clone;
		} catch (e) { return null; }
	}
	const clonePlayerPart = (P, name) => cloneSpriteObj(P && P[name]);
	function cloneContainerPart(P, name) {
		try {
			const src = P && P[name];
			if (!src || typeof src.addChild !== "function") return null;
			const wrapper = new src.constructor();
			wrapper.x = src.x; wrapper.y = src.y; wrapper.rotation = src.rotation || 0;
			if (src.scale) wrapper.scale.copyFrom(src.scale);
			for (const child of src.children || []) { const c = cloneSpriteObj(child); if (c) wrapper.addChild(c); }
			return wrapper;
		} catch (e) { return null; }
	}
	function rebuildPuppetParts(state, puppet, toolsSet) {
		try {
			const P = state.session.rendering.pixi.sprites.player;
			puppet.removeChildren(); puppet.__aimParts = [];
			for (const name of PUPPET_PART_ORDER) {
				if (!PUPPET_ALWAYS_PARTS.has(name) && !toolsSet.has(name)) continue;
				const clone = clonePlayerPart(P, name);
				if (!clone) continue;
				puppet.addChild(clone);
				if (AIM_PART_NAMES.has(name)) puppet.__aimParts.push(clone);
			}
			if (puppet.__trail) puppet.addChild(puppet.__trail);
			if (puppet.__muzzleFlash) puppet.addChild(puppet.__muzzleFlash);
		} catch (e) { log("rebuildPuppetParts error:", e.message); }
	}
	function getVisibleTools(state) {
		try { const P = state.session.rendering.pixi.sprites.player; const out = []; for (const n of PUPPET_TOOL_PARTS) if (P[n] && P[n].visible) out.push(n); return out; } catch (e) { return []; }
	}
	function getFacing(state) {
		try { return state.session.rendering.pixi.sprites.player.container.scale.x < 0 ? -1 : 1; } catch (e) { return null; }
	}
	function getAimAngle(state) {
		try {
			const mouse = state.session.input && state.session.input.mouse, pl = state.store.player;
			if (!mouse || !mouse.worldPosition || !pl) return 0;
			return Math.atan2(mouse.worldPosition.y - pl.y, mouse.worldPosition.x - pl.x);
		} catch (e) { return 0; }
	}
	// Pozycja cursor in world (same space as player.x/y → works with worldToScreen).
	function getMouseWorld(state) {
		try { const mouse = state.session.input && state.session.input.mouse; const worldPosition = mouse && mouse.worldPosition; return worldPosition && typeof worldPosition.x === "number" ? { x: Math.round(worldPosition.x), y: Math.round(worldPosition.y) } : null; } catch (e) { return null; }
	}
	// Intencja BUDOWANIA: what the player will do next (pose phantom). Source (0.5.4): With normal hotbar pose
	// The game keeps the active type in `session.building.activeStructureType`; `customData.selectedStructures` is only
	// for copy-paste blueprints → that's why the NIGDY phantom didn't show up before). Fallback: player.action.id
	// (action Building carries id=structureId). Blueprint copy: add offsets from selectedStructures.
	function getBuildIntent(state) {
		try {
			const ss = state.session || {};
			const pl = state.store && state.store.player;
			let bt = ss.building && ss.building.activeStructureType;
			// Primary source (confirmed by GHOST-DIAG): `activeStructureType` is null while hovering; selected type
			// budynku bierzemy z aktywnego slotu hotbara: hotbar.bars[hotbarIndex][activeSlotIndex].
			if (bt == null && pl && pl.hotbar && pl.hotbar.activeSlotIndex != null) {
				const bar = pl.hotbar.bars && pl.hotbar.bars[pl.hotbar.hotbarIndex];
				const item = bar && bar[pl.hotbar.activeSlotIndex];
				if (item != null) bt = (typeof item === "object") ? (item.structureType != null ? item.structureType : item.type != null ? item.type : item.id) : item;
			}
			if (bt == null) {
				const a = pl && pl.action;
				if (a && a.id != null) bt = a.id; // {type:Building, id:structureId}
			}
			// One-time diagnostic: if an active hotbar slot has no resolved type, dump the item shape and state.
			if (bt == null && pl && pl.hotbar && pl.hotbar.activeSlotIndex != null && !sandustryMP._biDumped) {
				sandustryMP._biDumped = true;
				try {
					const hb = pl.hotbar, bar = hb.bars && hb.bars[hb.hotbarIndex], item = bar && bar[hb.activeSlotIndex];
					log("GHOST-DIAG: activeSlot=" + hb.activeSlotIndex + " hotbarIndex=" + hb.hotbarIndex,
						"ITEM=" + JSON.stringify(item) + " (typeof " + typeof item + (item && typeof item === "object" ? " keys=" + Object.keys(item).join(",") : "") + ")",
						"hotbar keys=" + Object.keys(hb).join(","),
						"session.building=" + JSON.stringify(ss.building));
				} catch (e2) { log("GHOST-DIAG err:", e2.message); }
			}
			if (bt == null) return null;
			if (!sandustryMP._biOk) { sandustryMP._biOk = true; log("GHOST OK: position intent detected, bt=" + JSON.stringify(bt)); }
			// blueprint (kopiuj-wklej): kilka struktur z offsetami; single-struct → [[0,0]] pod kursorem
			const cd = ss.action && ss.action.customData;
			const sel = cd && Array.isArray(cd.selectedStructures) ? cd.selectedStructures : null;
			let offs = [[0, 0]];
			if (sel && sel.length > 1) { offs = []; for (let i = 0; i < sel.length && i < 24; i++) offs.push([(sel[i].x | 0), (sel[i].y | 0)]); }
			return { bt, offs };
		} catch (e) { return null; }
	}
	function getTrailAlpha(state) {
		try {
			const tc = state.session.rendering.pixi.sprites.player.trailContainer;
			if (!tc) return 0;
			if (tc.alpha > 0) return Math.round(tc.alpha * 100) / 100;
			const child = tc.children && tc.children[0];
			return child ? Math.round(child.alpha * 100) / 100 : 0;
		} catch (e) { return 0; }
	}
	function getPuppetParent(state) { try { return state.session.rendering.pixi.sprites.player.container.parent || null; } catch (e) { return null; } }
	function ensurePeerPuppet(state, id) {
		const parent = getPuppetParent(state);
		if (!parent) return null;
		let pp = sandustryMP.peerPuppets.get(id);
		if (pp) { if (pp.parent === parent && !pp.puppet._destroyed) return pp; try { pp.parent.removeChild(pp.puppet); } catch (e) {} sandustryMP.peerPuppets.delete(id); pp = null; }
		try {
			const P = state.session.rendering.pixi.sprites.player;
			if (!P || !P.container) return null;
			const puppet = new P.container.constructor();
			const muzzleFlash = clonePlayerPart(P, "muzzleFlash");
			if (muzzleFlash) { muzzleFlash.visible = false; puppet.__muzzleFlash = muzzleFlash; }
			const trail = cloneContainerPart(P, "trailContainer");
			if (trail) { trail.alpha = 0; puppet.__trail = trail; }
			rebuildPuppetParts(state, puppet, new Set());
			parent.addChild(puppet);
			pp = { puppet, parent, toolsKey: "", muzzleFlash, flashUntil: 0 };
			sandustryMP.peerPuppets.set(id, pp);
			return pp;
		} catch (e) { log("ensurePeerPuppet error:", e.message); return null; }
	}
	function removePeerPuppet(id) { const pp = sandustryMP.peerPuppets.get(id); if (!pp) return; try { pp.parent.removeChild(pp.puppet); } catch (e) {} sandustryMP.peerPuppets.delete(id); }
	function removeAllPeerPuppets() { for (const id of [...sandustryMP.peerPuppets.keys()]) removePeerPuppet(id); }
	function worldToScreen(state, wx, wy) {
		try { const pos = sandustryMP.gameApi && sandustryMP.gameApi.rendering && sandustryMP.gameApi.rendering.getDrawPos && sandustryMP.gameApi.rendering.getDrawPos(state, wx, wy); if (pos && typeof pos.x === "number") return pos; } catch (e) {}
		const cam = state.session && state.session.camera;
		return cam ? { x: wx - cam.x, y: wy - cam.y } : { x: wx, y: wy };
	}
	function peerProjectileCount(id, p) { return sandustryMP.net.role === "client" ? (sandustryMP.remoteProjectiles || []).length : (p.projectiles || []).length; }

	function drawGhosts(state) {
		if (!sandustryMP.peers.size) { if (sandustryMP.peerPuppets.size) removeAllPeerPuppets(); return; }
		const gc = ensureGhostCanvas();
		const ctx = gc && gc.getContext("2d");
		if (ctx) ctx.clearRect(0, 0, gc.width, gc.height);
		const now = performance.now();
		for (const [id, p] of sandustryMP.peers) {
			const dtSince = Math.min(now - (p.tUpdate || now), 250);
			const predX = p.tx + (p.vx || 0) * dtSince, predY = p.ty + (p.vy || 0) * dtSince;
			p.x += (predX - p.x) * 0.35; p.y += (predY - p.y) * 0.35;
			const stale = now - p.lastSeen > 3000;
			const speed = Math.hypot(p.vx || 0, p.vy || 0);
			if (speed > 0.02 && p.syncedFacing == null) p.facing = (p.vx || 0) < 0 ? -1 : 1;
			const facing = (p.syncedFacing === 1 || p.syncedFacing === -1) ? p.syncedFacing : (p.facing || 1);
			const screen = worldToScreen(state, p.x + PUPPET_ANCHOR_DX, p.y + PUPPET_ANCHOR_DY);
			const pp = ensurePeerPuppet(state, id);
			if (pp) {
				pp.puppet.x = screen.x; pp.puppet.y = screen.y;
				pp.puppet.scale.x = facing; pp.puppet.alpha = stale ? 0.35 : 1; pp.puppet.visible = true;
				const toolsKey = (p.tools || []).join(",");
				if (pp.toolsKey !== toolsKey) { rebuildPuppetParts(state, pp.puppet, new Set(p.tools || [])); pp.toolsKey = toolsKey; }
				const localAim = facing === -1 ? Math.PI - (p.aim || 0) : (p.aim || 0);
				if (pp.puppet.__aimParts) for (const part of pp.puppet.__aimParts) part.rotation = localAim;
				if (pp.puppet.__trail) pp.puppet.__trail.alpha = p.trailAlpha || 0;
				const projCount = peerProjectileCount(id, p);
				if (projCount > (p._lastProjCount || 0)) pp.flashUntil = now + MUZZLE_FLASH_MS;
				p._lastProjCount = projCount;
				if (pp.muzzleFlash) pp.muzzleFlash.visible = now < pp.flashUntil;
			}
			const onScreen = gc && screen.x > -20 && screen.y > -20 && screen.x < gc.width + 20 && screen.y < gc.height + 20;
			if (ctx && gc && onScreen) {
				ctx.globalAlpha = stale ? 0.4 : 1;
				ctx.font = "10px monospace"; ctx.textAlign = "center";
				ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.lineWidth = 3;
				ctx.strokeText(p.nick, screen.x, screen.y - NAMETAG_OFFSET_PX);
				ctx.fillText(p.nick, screen.x, screen.y - NAMETAG_OFFSET_PX);
				ctx.globalAlpha = 1;
			} else if (ctx && gc && !stale) {
				if (!p.color) p.color = peerColor(id);
				ctx.globalAlpha = 0.85; drawOffscreenIndicator(ctx, gc, screen, p.color, p.nick); ctx.globalAlpha = 1;
			}
		}
		if (ctx && gc) {
			ctx.fillStyle = "#ffd54f";
			const drawProj = (list) => {
				if (!list) return;
				for (const pr of list) { const s = worldToScreen(state, pr.x, pr.y); if (s.x < -20 || s.y < -20 || s.x > gc.width + 20 || s.y > gc.height + 20) continue; ctx.fillRect(s.x - 2, s.y - 2, 4, 4); }
			};
			drawProj(sandustryMP.remoteProjectiles);
			for (const p of sandustryMP.peers.values()) drawProj(p.projectiles);
		}
		// Real-time action preview: placement ghost plus grabber or vacuum reticle.
		// Pokazuje GDZIE another player is about to build a building / where he collects resources - so don't do it this time
		// same place. Rysowane in player color. Kursor in the world (mwx/mwy) + build intention (bt/boffs).
		if (ctx && gc) {
			for (const [id, p] of sandustryMP.peers) {
				if (p.mwx == null || p.mwy == null || now - p.lastSeen > 3000) continue;
				if (!p.color) p.color = peerColor(id);
				const cur = worldToScreen(state, p.mwx, p.mwy);
				if (cur.x < -80 || cur.y < -80 || cur.x > gc.width + 80 || cur.y > gc.height + 80) continue;
				const s1 = worldToScreen(state, p.mwx + 4, p.mwy); // +1 cell (=4 world) → pixels/cell (zoom scale)
				let ppc = Math.abs(s1.x - cur.x); if (!(ppc > 0.5)) ppc = 6;
				if (p.bt != null && Array.isArray(p.boffs) && p.boffs.length) {
					// FANTOM POZY - rectangles where the player is about to place (first offset = under the cursor)
					const base = p.boffs[0];
					ctx.save();
					ctx.strokeStyle = p.color.body; ctx.fillStyle = p.color.body; ctx.lineWidth = 2;
					const sz = Math.max(8, ppc);
					for (const off of p.boffs) {
						const wx = p.mwx + (((off && off[0]) | 0) - (base[0] | 0)) * 4, wy = p.mwy + (((off && off[1]) | 0) - (base[1] | 0)) * 4;
						const s = worldToScreen(state, wx, wy);
						ctx.globalAlpha = 0.22; ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
						ctx.globalAlpha = 0.9; ctx.strokeRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
					}
					ctx.restore();
				} else if ((p.tools || []).indexOf("vacuum") >= 0) {
					// RETICLE grabber/vacuum - range circle where the player collects (so as not to take the same resources)
					const r = Math.max(10, ppc * 4); // ~R=4 cells (vacuum range with hostHarvestVacuum)
					ctx.save();
					ctx.strokeStyle = p.color.body; ctx.fillStyle = p.color.body; ctx.lineWidth = 2;
					ctx.globalAlpha = 0.9; ctx.setLineDash([5, 4]);
					ctx.beginPath(); ctx.arc(cur.x, cur.y, r, 0, Math.PI * 2); ctx.stroke();
					ctx.setLineDash([]);
					ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(cur.x, cur.y, 2.5, 0, Math.PI * 2); ctx.fill();
					ctx.restore();
				}
			}
			ctx.globalAlpha = 1;
		}
	}

	// ------------------------------------------------------------------
	// Hook per-frame (patch w bundle.js)
	// ------------------------------------------------------------------
	sandustryMP._frame = (state, gameApi) => {
		if (sandustryMP.net.role === "host") sandustryMP.det.hostEpoch++;
		if (!sandustryMP.state) {
			sandustryMP.state = state;
			if (gameApi) sandustryMP.gameApi = gameApi;
			log("Game state captured; scene:", state.store && state.store.scene && state.store.scene.active,
				"worldId:", state.store && state.store.meta && state.store.meta.worldId,
				"gameApi:", gameApi ? Object.keys(gameApi).slice(0, 25).join(",") : "MISSING");
		}
		if (gameApi && !sandustryMP.gameApi) sandustryMP.gameApi = gameApi;
		// scene/world change detection (state reload)
		if (sandustryMP.state !== state) { sandustryMP.state = state; sandustryMP.wsx.paused = false; log("New state object detected, possibly due to a scene change"); }
		ensureDecisionClock(state);
		// Garde anti-flood poses: when entering the world (change scene.active) the game reconstructs structures
		// when running building:place → do not forward them for 3s (see sandustryMP._place).
		{ const sc = state.store && state.store.scene && state.store.scene.active; if (sc !== sandustryMP._lastScene) { sandustryMP._lastScene = sc; sandustryMP._loadGuardUntil = performance.now() + 3000; } }
		if (!sandustryMP._debugDumped && state.session && state.session.camera) {
			sandustryMP._debugDumped = true;
			try {
				const sharedState = state.shared || {};
				const dump = {};
				for (const key of Object.keys(sharedState)) {
					const value = sharedState[key];
					if (value && value.buffer && value.length !== undefined) dump[key] = value.constructor.name + "[" + value.length + "]";
					else if (value && typeof value === "object") dump[key] = "{" + Object.keys(value).slice(0, 30).join(",") + "}";
					else dump[key] = typeof value;
				}
				log("SHARED:", JSON.stringify(dump));
				if (sharedState.sim) {
					const sd = {};
					for (const key of Object.keys(sharedState.sim)) {
						const value = sharedState.sim[key];
						if (value && value.buffer && value.length !== undefined) sd[key] = value.constructor.name + "[" + value.length + "]";
						else if (value && typeof value === "object" && value !== null) sd[key] = "{" + Object.keys(value).slice(0, 40).join(",") + "}";
						else sd[key] = String(value);
					}
					log("SHARED.sim:", JSON.stringify(sd));
				}
				log("WORLD size:", JSON.stringify(state.store.world && state.store.world.size),
					"env keys:", Object.keys(state.environment || {}).join(","),
					"manager:", managerWorker(state) ? "OK" : "MISSING");
			} catch (e) { log("dump error:", e.message); }
		}
		const now = performance.now();
		// Completion of FH.game.load happens in this fresh renderer. Only now is it
		// safe to trust mirror packets and delete the temporary imported save.
		if (sandustryMP.net.role === "client" && !sandustryMP._baseWorldReady && state.store && state.store.scene && state.store.scene.active !== 1 && !sandustryMP._finishingTransferLoad) {
			let pendingTransfer = null;
			try { const raw = localStorage.getItem("smp_pending_transfer_load"); if (raw) pendingTransfer = JSON.parse(raw); } catch (e) {}
			if (pendingTransfer && pendingTransfer.saveId) {
				sandustryMP._finishingTransferLoad = true;
				localStorage.removeItem("smp_pending_transfer_load");
				sandustryMP._baseWorldReady = true;
				sandustryMP._worldRxDone = true;
				sandustryMP._gotHostWorld = true;
				sandustryMP._pendingTrustUntil = now + 15000;
				sandustryMP._pendingPostLoadResync = true;
				setStatus(t("world_imported_loaded", pendingTransfer.name || "host world"), "#5f5");
				log("Imported host save is loaded; enabling mirror and removing temporary save:", pendingTransfer.saveId);
				removeTransferSave(pendingTransfer.saveId, pendingTransfer.previousLastPlayed || null).finally(() => { sandustryMP._finishingTransferLoad = false; });
			}
		}
		if (sandustryMP.net.role === "client" && sandustryMP._baseWorldReady && sandustryMP._pendingPostLoadResync && sandustryMP.peers.size) {
			sandustryMP._pendingPostLoadResync = false;
			sandustryMP._autoResynced = true;
			try { net.send({ t: "resync" }); log("AUTO-RESYNC after imported host save finished loading"); } catch (e) { sandustryMP._pendingPostLoadResync = true; }
		}
		updateClientConveyorAnimations(state);
		if (net && sandustryMP.net.role !== "idle" && state.store && state.store.player && now - sandustryMP._lastPosSend > 33) {
			sandustryMP._lastPosSend = now;
			const pl = state.store.player;
			const bi = getBuildIntent(state);
			const mw = getMouseWorld(state);
			if (bi && !sandustryMP._biLogged) { sandustryMP._biLogged = true; log("Position intent detected (the ghost should appear for the other player): bt=" + bi.bt); }
			net.send({ t: "pos", x: Math.round(pl.x * 10) / 10, y: Math.round(pl.y * 10) / 10, tools: getVisibleTools(state), facing: getFacing(state), aim: getAimAngle(state), trail: getTrailAlpha(state),
				mwx: mw ? mw.x : null, mwy: mw ? mw.y : null,           // cursor in the world (action preview)
				bt: bi ? bi.bt : null, boffs: bi ? bi.offs : null });   // intencja pozy: typ + offsety (fantom u innych graczy)
		}
		// ping/pong (RTT) - sending every 1s, refreshing HUD every 0.5s (dotNine contribution)
		if (net && sandustryMP.net.role !== "idle" && sandustryMP.peers.size && now - (sandustryMP._lastPingSent || 0) > 1000) {
			sandustryMP._lastPingSent = now;
			for (const id of sandustryMP.peers.keys()) { try { net.send({ t: "ping", ts: now }, id); } catch (e) {} }
		}
		if (now - (sandustryMP._lastPingUi || 0) > 500) { sandustryMP._lastPingUi = now; updatePingDisplay(); }
		// world sync + struktury + zasoby + encje
		subscribeGameEvents(state);
		ensureMenuUi(state); // MULTIPLAYER button in main menu + lobby (throttle 500 ms in the middle)
		// host: auto-send save when in a world with players and has not yet sent TEGO world (key: worldId).
		// Check continuously instead of relying on the menu-to-world edge, which sampling can miss. Contributed by dotNine.
		if (sandustryMP.net.role === "host" && sandustryMP.peers.size && state.store && state.store.scene && state.store.scene.active !== 1) {
			const wid = (state.store.meta && state.store.meta.worldId) || "unknown";
			if ((sandustryMP._pendingWorldSend || sandustryMP._autoSentWid !== wid) && !sandustryMP._creatingWorldTransfer && now >= (sandustryMP._nextWorldSendAttempt || 0)) {
				sandustryMP._pendingWorldSend = true;
				sandustryMP._nextWorldSendAttempt = now + 2000;
				log("Starting pending host world transfer for", wid);
				sendWorld();
			}
		}
		// Do not stream while the host is in the menu (Akriz and derErste67 instant-disconnect fix); menu world buffers
		// belong to SCENY MENU; streaming them to the client painted garbage and triggered it for him
		// auto-exit to menu (everApplied in menu) = client exited a second after joining.
		if (isHostSync() && state.store.scene && state.store.scene.active !== 1) {
			scanDirty(state);
			maybeSendBatch(state);
			sendSnapshotIfDue(state);
			sendResourcesIfDue(state);
			sendEntitiesIfDue(state);
			sendWorldItemsIfChanged(state); // szybkie dropy (G12)
		}
		// Dobijanie after demolition (see _demol): 250ms after dragging, check whether there are any
		// structures missed by the game (tiles stuck in QUEUED) and remove them by SA.removeAt.
		// This cleanup runs for both host and solo modes because jammed blocks persist in saves.
		{
			const hd = sandustryMP._hostDemolRect;
			if (hd && performance.now() - hd.t > 400) {
				sandustryMP._hostDemolRect = null;
				try {
					const SA = structNs();
					if (SA && (hd.x1 - hd.x0 + 1) * (hd.y1 - hd.y0 + 1) <= 40000) {
						const leftovers = new Map();
						for (let y = hd.y0; y <= hd.y1; y++) for (let x = hd.x0; x <= hd.x1; x++) {
							try { const st = SA.getAtCell(state, x, y); if (st) leftovers.set(structKey(st), st); } catch (e) {}
						}
						if (leftovers.size) {
							log("Demolition cleanup: the game skipped", leftovers.size, "structures (queued tiles?) — removing them with removeAt");
							for (const st of leftovers.values()) { try { SA.removeAt(state, st.x, st.y, {}); } catch (e) {} }
							if (sandustryMP.net.role === "host" && sandustryMP.peers.size) try { net.send({ t: "st", k: "rm", list: [...leftovers.values()].map(slimStruct) }); } catch (e) {}
							// removeAt can only queue removal. In the same pass getAtCell continues
							// can see the structure, so the following sweep of the area will rightly not move its red tiles.
							// Return after another 250 ms when the structure register has had time to empty. Limit protects
							// before an infinite loop with an effectively unremovable structure.
							if ((hd.retry || 0) < 6) sandustryMP._hostDemolRect = { ...hd, t: performance.now(), retry: (hd.retry || 0) + 1 };
						}
						// Orphaned tiles ("red bricks"): the structure no longer exists (`getAtCell` is null), but its tiles remain.
						// "clean" with visible blocks!), but structure-owned terrain cells can be removed safely.
						// Orphaned tiles remain because game demolition clears cells only while removing a live structure.
						// Rozpoznanie: sim.cellIds → terrain id (1..1000) → sim.terrainType[id]. Usuwamy by
						// FH.terrains.removeAt OFFXQ15QXZ cells without living structure (Block tile without structure = garbage).
						// For clients, clear tiles only when the message contains the exact selection rectangle.
						// selections; old anchor bbox clients still skip this step.
						if (hd.src !== "client" || hd.cleanOrphans) try {
							const sharedState = state.shared || {};
							const simc = sharedState.sim && sharedState.sim.cellIds;
							const tt = sharedState.sim && sharedState.sim.terrainType;
							const TR = sandustryMP.gameApi.terrains;
							const { width: W } = worldBuffers(state);

							if (simc && tt && TR && TR.removeAt && W) {
								const sim = new Uint32Array(simc.buffer, simc.byteOffset, simc.length);
								const H = Math.floor(sim.length / W);
								// BLOB-EXPAND (idea TCentraL, PR #6): from an orphaned tile we expand to the entire
								// the adjacent stain (the red blocks POZA also partially come off).
								// The allow-list includes regular/sliding foundations plus conveyor and shaker strips.
								// (2) getAtCell for EACH stain cell (spot touching ZDROWEGO painted
								// foundation cannot eat it), (3) without mutating y in the middle of the loop (it lost blobs),
								// (4) expansion limit of 64 cells from seed (no marathon across the entire map).
								const isOrphanTile = (xx, yy) => {
									const n = sim[xx + yy * W];
									if (n <= 0 || n > 1000) return false;
									const terrainType = tt[n];
									if (!STRUCTURE_TERRAIN_TYPES.has(terrainType)) return false;
									try { if (SA.getAtCell(state, xx, yy)) return false; } catch (e) { return false; }
									return true;
								};
								let cleaned = 0;
								const LIM = 64;
								for (let y = hd.y0; y <= hd.y1; y++) {
									for (let x = hd.x0; x <= hd.x1; x++) {
										if (!isOrphanTile(x, y)) continue;
										let r = x;
										while (r + 1 < W && r - x < LIM && isOrphanTile(r + 1, y)) r++;
										let b = y;
										while (b + 1 < H && b - y < LIM && isOrphanTile(x, b + 1)) b++;
										for (let yy = y; yy <= b; yy++) for (let xx = x; xx <= r; xx++) {
											if (!isOrphanTile(xx, yy)) continue;
											try { TR.removeAt(state, xx, yy); cleaned++; } catch (e) {}
										}
										x = r; // line scanned to r; y remains (the outer loop scans the next lines)
									}
								}
								if (cleaned) log("Demolition cleanup: removed", cleaned, "orphaned tiles (expanded connected region)");
							}
						} catch (e) {
							log("ORPHAN CLEANUP ERROR:", e.message);
						}
					}
				} catch (e) { log("Demolition cleanup error:", e.message); }
			}
		}
		if (isClientSync()) {
			// Heartbeat re-pause (fix G1): ESC-game menu sends its own SetPaused(false) when closed and silently
			// resumed client simulation (our flag still true → setClientPaused did not re-pause) →
			// Double simulation fights the mirror and causes severe desync. Re-send `[54,true]` every two seconds; it is idempotent.
			if (sandustryMP.wsx.paused && now - (sandustryMP._rePauseT || 0) > 2000) {
				sandustryMP._rePauseT = now;
				const mgr = managerWorker(state);
				if (mgr) try { mgr.postMessage([54, true]); } catch (e) {}
			}
			// Mirror ack at 10 Hz, matching the host's batch rate. The host derives its lag from this and
			// throttles itself. Cheap (~20 B) and sent unordered, so it never queues behind world packets.
			// A slower ack (2 Hz say) would add ~5 batches of its own age to the measurement and the
			// controller would throttle a perfectly healthy link.
			if (sandustryMP._lastAppliedSq != null && now - (sandustryMP._lastAckT || 0) > 100) {
				sandustryMP._lastAckT = now;
				try { net.send({ t: "wcack", sq: sandustryMP._lastAppliedSq }); } catch (e) {}
			}
			sendMyProjectilesIfDue(state);
			sendResourceDeltaIfDue(state); // send client resource increments to host (dotNine)
			// flush batchy ognia/lodu co ~60 ms
			if (sandustryMP._fireQ.length && now - (sandustryMP._lastFireB || 0) > 60) { sandustryMP._lastFireB = now; try { net.send({ t: "act", k: "fireB", c: sandustryMP._fireQ }); } catch (e) {} sandustryMP._fireQ = []; }
			if (sandustryMP._cryoQ.length && now - (sandustryMP._lastCryoB || 0) > 60) { sandustryMP._lastCryoB = now; try { net.send({ t: "act", k: "cryoB", c: sandustryMP._cryoQ }); } catch (e) {} sandustryMP._cryoQ = []; }
			if (sandustryMP._volcQ.length && now - (sandustryMP._lastVolcB || 0) > 60) { sandustryMP._lastVolcB = now; try { net.send({ t: "act", k: "volcB", c: sandustryMP._volcQ }); } catch (e) {} sandustryMP._volcQ = []; }
			if (sandustryMP._caulkQ.length && now - (sandustryMP._lastCaulkB || 0) > 60) { sandustryMP._lastCaulkB = now; try { net.send({ t: "act", k: "caulkB", c: sandustryMP._caulkQ }); } catch (e) {} sandustryMP._caulkQ = []; }
			if (sandustryMP._caulkRmQ.length && now - (sandustryMP._lastCaulkRmB || 0) > 60) { sandustryMP._lastCaulkRmB = now; try { net.send({ t: "act", k: "caulkRmB", c: sandustryMP._caulkRmQ }); } catch (e) {} sandustryMP._caulkRmQ = []; }
			if (sandustryMP._shakeQ.length && now - (sandustryMP._lastShakeB || 0) > 60) { sandustryMP._lastShakeB = now; try { net.send({ t: "act", k: "shakeB", c: sandustryMP._shakeQ }); } catch (e) {} sandustryMP._shakeQ = []; }
			// Hint: connected, but the host has not sent a world yet, so the player sees nothing.
			if (!sandustryMP.wsx.everApplied && !sandustryMP.wsx.mismatchLogged && sandustryMP.peers.size > 0 && now - (sandustryMP._waitHintT || 0) > 3000) {
				sandustryMP._waitHintT = now;
				if (!sandustryMP._worldRx) setStatus(t("waiting_world"), "#fd5"); // do not overwrite "Receiving world x/y"
			}
			// SELF-HEALING (fix TCentraL reconnect on large map): no world-begin despite connection
			// (host auto-send failed / lost) → client asks for save every 15 s, MAX 4 times per session,
			// and NIGDY after successful world reception (_worldRxDone) - aka transfer/reload loop (0.9.58!).
			if (!sandustryMP._worldRxDone && !sandustryMP._gotHostWorld && !sandustryMP._worldRx && !sandustryMP.wsx.everApplied && sandustryMP.peers.size > 0 &&
				(sandustryMP._worldReqN || 0) < 4 && now - (sandustryMP._worldReqT || 0) > 15000) {
				sandustryMP._worldReqT = now; sandustryMP._worldReqN = (sandustryMP._worldReqN || 0) + 1;
				try { net.send({ t: "world-req" }); log("world-req " + sandustryMP._worldReqN + "/4: didn't get world-begin - please host to save"); } catch (e) {}
			}
			// client FAKTYCZNIE was in the world in this session - auto-exit condition (belt and harness after
			// instant-kick incident: everApplied set in the menu cannot disconnect)
			if (state.store.scene && state.store.scene.active !== 1) sandustryMP.wsx.wasInWorld = true;
			// Returning to the title menu exits the session (tony.s.jennette suggestion): after the mirror
			// it was already working (everApplied) And the client was in the world, scene 1 means conscious exit -
			// Disconnect cleanly instead of leaving the session in limbo. Before the first world, a client legitimately waits in the menu.
			// !_loadingWorld: during NASZEGO FH.game.load scene flies through menu - auto-exit
			// During this window it previously caused `net.stop()` → reconnect → transfer → load loops (ZeroHazard report).
			if (sandustryMP.wsx.everApplied && sandustryMP.wsx.wasInWorld && !sandustryMP._loadingWorld && state.store.scene && state.store.scene.active === 1) {
				log("Client returned to the title menu; leaving the co-op session");
				profileSave(state); // Save per-world position and equipment while paused, as required by `profileSave`.
				setClientPaused(false);
				try { net.stop(); } catch (e) {}
				setStatus(t("left_to_menu"), "#fd5");
				return; // the role is already idle - the rest of the client loop makes no sense in this frame
			}
			// When the client changes worlds or returns to the menu, clear tool state associated with the previous world.
			// (fix tony: "infinite items" - old _grabTool/tank from the previous world + mouse movements = grabPlace spam)
			const curWid = state.store.meta && state.store.meta.worldId;
			if (sandustryMP._curWid !== curWid) {
				sandustryMP._curWid = curWid;
				sandustryMP._grabTool = null;
				sandustryMP._grabPending = null;
				sandustryMP._grabbedCells.clear(); sandustryMP._placedCells.clear();
				sandustryMP._fireQ = []; sandustryMP._cryoQ = []; sandustryMP._volcQ = []; sandustryMP._caulkQ = []; sandustryMP._caulkRmQ = []; sandustryMP._shakeQ = [];
				if (sandustryMP._dataSeen) sandustryMP._dataSeen.clear();
				if (sandustryMP._dataEdited) sandustryMP._dataEdited.clear();
			}
			// client profile (G7-lite): save every 10s (item+equipment per host world)
			if (now - (sandustryMP._profT || 0) > 10000) { sandustryMP._profT = now; profileSave(state); }
			scanDataEditsIfDue(state); // machine config edited by customer → forward (G5b)
			// AUGMENTY: client selection (post-artifact screen) mutates mods.augments locally - diff every 500ms
			// vs last snapshot of the stream → forward the entire object to the host (host = team authority).
			if (now - (sandustryMP._augScanT || 0) > 500) {
				sandustryMP._augScanT = now;
				try {
					const cur = JSON.stringify((state.store.mods && state.store.mods.augments) || null);
					if (sandustryMP._augLast !== undefined && cur !== sandustryMP._augLast && cur !== "null") {
						sandustryMP._augLast = cur;
						sandustryMP._augEditT = now;
						net.send({ t: "act", k: "aug", a: JSON.parse(cur) });
						log("CLIENT augments → forward (selection in the augments screen)");
					}
				} catch (e) {}
			}
			// Mirror stall (G4): if data stops while the host is not paused, report how long the client has waited.
			if (sandustryMP.wsx.everApplied && !sandustryMP._hostPausedShown && sandustryMP._lastWcT && now - sandustryMP._lastWcT > 4000 && now - (sandustryMP._stallHintT || 0) > 2000) {
				sandustryMP._stallHintT = now;
				setStatus(t("sync_stalled", Math.round((now - sandustryMP._lastWcT) / 1000)), "#fd5");
			}
		}
		drawGhosts(state);
	};
})();
