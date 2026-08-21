// SandustryMP renderer networking subscriptions and connection state.
(() => {
	"use strict";
	window.SandustryMPNetwork = {
		create(dependencies) {
			const { sandustryMP, log, t, resetWorldQueue, updateLobbyIdDisplay, showInviteButton, resetDecisionClockSession, enqueueFullWorld, sendWorld, profileSave, removePeerPuppet, removeAllPeerPuppets, updatePingDisplay, setClientPaused, updatePanel, renderLobby, handleMsg } = dependencies;
			// ------------------------------------------------------------------
			// Networking
			// ------------------------------------------------------------------
			const net = window.sandustrympNet;
			if (!net) log("WARNING: missing window.sandustrympNet - preload not updated?");

			const setStatus = (text, color) => {
				if (sandustryMP._hud) { const el = sandustryMP._hud.querySelector("#smp-status"); el.textContent = text; el.style.color = color || "#8f8"; }
			};
			const setSyncInfo = (text) => {
				if (sandustryMP._hud) sandustryMP._hud.querySelector("#smp-sync").textContent = text;
			};
			// chat: add a line (max 5 visible), text via textContent (zero HTML injection)
			const addChat = (nick, text) => {
				try {
					if (!sandustryMP._hud) return;
					const lg = sandustryMP._hud.querySelector("#smp-chat-log");
					if (!lg) return;
					const line = document.createElement("div");
					const b = document.createElement("b"); b.textContent = nick + ": "; b.style.color = "#7af";
					line.appendChild(b); line.appendChild(document.createTextNode(text));
					lg.appendChild(line);
					while (lg.children.length > 5) lg.removeChild(lg.firstChild);
				} catch (e) {}
			};

			const isClientSync = () => sandustryMP.net.role === "client" && sandustryMP.state;
			const isHostSync = () => sandustryMP.net.role === "host" && sandustryMP.state && sandustryMP.peers.size > 0;

			if (net) {
				net.onEvent((ev) => {
					log("net event:", ev.kind, JSON.stringify(ev).slice(0, 150));
					if (ev.kind === "hosting") {
						sandustryMP.net.role = "host"; sandustryMP.net.transport = ev.transport;
						setStatus(ev.transport === "steam" ? t("hosting_steam") : t("hosting_lan", ev.port));
						sandustryMP.net.lobbyId = ev.lobbyId || null; sandustryMP._autoSentWid = null; // auto-send reset; remember lobbyId
						resetWorldQueue(); // new host session starts clean, peer-connected re-queues the full world
							updateLobbyIdDisplay();
							if (ev.transport === "steam") showInviteButton(true);
					} else if (ev.kind === "joined") {
						sandustryMP.net.role = "client"; sandustryMP.net.transport = ev.transport;
						resetDecisionClockSession();
						sandustryMP.wsx.everApplied = false; sandustryMP.wsx.mismatchLogged = false; sandustryMP.wsx.wasInWorld = false; // new client session
						sandustryMP._lastAppliedSq = null; sandustryMP._lastAckT = 0; // new host numbers its batches from zero, a stale ack would be wrong
						sandustryMP._worldRxDone = false; sandustryMP._worldReqN = 0; sandustryMP._worldReqT = performance.now(); sandustryMP._autoResynced = false; sandustryMP._autoLoadedOnce = false; // fresh cycle; 1. world-req at the earliest 15 seconds after join (host auto-send has the advantage)
						sandustryMP._trustedWid = null; sandustryMP._pendingTrustUntil = 0;
						sandustryMP._gotHostWorld = false; // Critical: never carry world trust between sessions; a different host may have a different world.
						sandustryMP._fireQ = []; sandustryMP._cryoQ = []; sandustryMP._grabbedCells.clear(); sandustryMP._placedCells.clear(); sandustryMP._volcQ = []; sandustryMP._caulkQ = []; sandustryMP._caulkRmQ = []; sandustryMP._shakeQ = []; // previous session status = other coordinates/world
						// own nickname (localStorage) broadcast via the existing hello protocol - no changes in the IPC bridge
						if (sandustryMP._nickCustom) { try { net.send({ t: "hello", nick: sandustryMP._nickCustom }); } catch (e) {} }
						setStatus(t("joined", ev.transport));
					} else if (ev.kind === "peer-hello" || ev.kind === "peer-connected") {
						const isNew = !sandustryMP.peers.has(ev.id);
						if (isNew) sandustryMP.peers.set(ev.id, { nick: ev.nick || "?", x: 0, y: 0, tx: 0, ty: 0, lastSeen: performance.now(), joinAnnounced: false });
						const peerState = sandustryMP.peers.get(ev.id);
						if (ev.nick) peerState.nick = ev.nick;
						if (ev.kind === "peer-hello" && !peerState.joinAnnounced) {
							peerState.joinAnnounced = true;
							addChat("★", t("chat_joined", peerState.nick || "?"));
						}
						// Reply only to the connection event. Replying to every hello creates an endless hello-response loop.
						if (ev.kind === "peer-connected" && sandustryMP._nickCustom) { try { net.send({ t: "hello", nick: sandustryMP._nickCustom }, ev.id); } catch (e) {} }
						setStatus(t("players", sandustryMP.peers.size + 1));
						if (sandustryMP.net.role === "host") {
							const hostInWorld = sandustryMP.state && sandustryMP.state.store && sandustryMP.state.store.scene && sandustryMP.state.store.scene.active !== 1;
							// A new player receives a full mirror only while the host is inside a world; menu buffers have unrelated dimensions.
							// they belong to the menu scene (we don't stream anyway, see gate in the frame hook).
							// Cooldown 20 s for AUTO - sending save: peer-hello cycle (reconnections when P2P is overloaded)
							// spammed transfers = client reload loop (ZeroHazard). Manual "Send World"
							// and world-req client work without cooldown (they have their own guards).
							if (hostInWorld) {
								enqueueFullWorld();
								if (performance.now() - (sandustryMP._autoSendT || 0) > 20000) { sandustryMP._autoSendT = performance.now(); sendWorld(); }
								else log("Auto-send skipped because the previous save transfer started less than 20 seconds ago");
							}
						}
					} else if (ev.kind === "peer-disconnected") {
						if (sandustryMP.state) profileSave(sandustryMP.state); // Persist the profile before any state transition (G7-lite).
						const gone = sandustryMP.peers.get(ev.id);
						if (gone) addChat("★", t("chat_left", gone.nick || "?"));
						sandustryMP.peers.delete(ev.id); removePeerPuppet(ev.id);
						setStatus(t("player_left", sandustryMP.peers.size + 1), "#fa5");
						// Keep the client paused. Silently unpausing created a forked world where the player appeared to continue locally.
						// locally without knowing that everything will be lost when you rejoin). Chcesz play solo → Stop.
					} else if (ev.kind === "stopped") {
						if (sandustryMP.state) profileSave(sandustryMP.state); // before role reset (isClientSync still true)
						sandustryMP.net.role = "idle"; sandustryMP.peers.clear(); removeAllPeerPuppets(); setStatus(t("offline"), "#aaa"); showInviteButton(false); sandustryMP.net.lobbyId = null; updateLobbyIdDisplay(); updatePingDisplay();
						sandustryMP._fireQ = []; sandustryMP._cryoQ = []; sandustryMP._grabbedCells.clear(); sandustryMP._placedCells.clear(); sandustryMP._volcQ = []; sandustryMP._caulkQ = []; sandustryMP._caulkRmQ = []; sandustryMP._shakeQ = [];
						sandustryMP._gotHostWorld = false;
						sandustryMP._lastAppliedSq = null; // drop the ack so it cannot throttle the next session
						resetWorldQueue();        // queue, row hashes and congestion state are all per session
						setClientPaused(false);
					} else if (ev.kind === "reconnecting") { setStatus(t("reconnecting", ev.attempt), "#fd5");
					} else if (ev.kind === "version-mismatch") setStatus(t("ver_mismatch"), "#f66");
					else if (ev.kind === "error") setStatus(t("error", ev.message), "#f66");
					updatePanel(); // badges/buttons/player list reflect ANY change in network state
					if (sandustryMP._lobbyOpen) renderLobby(false);
				});
				net.onMsg(({ from, msg }) => handleMsg(from, msg));
				net.status().then((s) => {
					sandustryMP.net.role = s.role; sandustryMP.net.transport = s.transport;
					try { sandustryMP._nickCustom = localStorage.getItem("smp_nick") || null; } catch (e) { sandustryMP._nickCustom = null; }
					sandustryMP._myNick = sandustryMP._nickCustom || s.myNick || null; // own nickname > nickname Steam > default (feedback TCentraL: LAN = "Player" permanently)
					sandustryMP._gameFp = s.gameFp || null; // game build imprint (guard of different builds between players)
					for (const p of s.peers) sandustryMP.peers.set(p.id, { nick: p.nick, x: 0, y: 0, tx: 0, ty: 0, lastSeen: performance.now() });
					if (s.role === "host") setStatus("HOST (" + s.transport + ") — gracze: " + (s.peers.length + 1));
					else if (s.role === "client") setStatus("CONNECTED - players: " + (s.peers.length + 1));
				}).catch(() => {});
			}

			return { net, setStatus, setSyncInfo, addChat, isClientSync, isHostSync };
		}
	};
})();
