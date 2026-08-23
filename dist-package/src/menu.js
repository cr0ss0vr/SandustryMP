// SandustryMP main-menu launcher and multiplayer lobby.
// Loaded before sandustrymp.js and initialized with renderer dependencies.
(() => {
	"use strict";
	window.SandustryMPMenu = {
		create(dependencies) {
			const { sandustryMP, t, net, setStatus, log, setClientPaused, VER } = dependencies;
	// ------------------------------------------------------------------
	// Menu main: MULTIPLAYER button + full screen lobby.
	// The game menu is React and Tailwind. Do not modify its managed tree directly.
	// thrown away on re-render); our button is a separate fixed element
	// positioned after getBoundingClientRect of real buttons.
	// ------------------------------------------------------------------
	// texts in multiple game languages (PL/EN/DE/FR/ES) - button position anchor Multiplayer
	const MENU_LEAF_TEXTS = ["kontynuuj", "continue", "weiter", "continuer", "continuar", "nowa", "new game", "neu", "wczytaj", "load game", "laden", "charger", "cargar", "opcje", "options", "optionen", "opciones", "wyjdź", "exit", "quit", "beenden", "quitter", "salir"];
	const MENU_ANCHOR_TEXTS = ["mody", "mods", "mapy", "maps", "karten", "cartes", "mapas"];
	const MENU_CONTINUE_TEXTS = ["continue", "kontynuuj", "weiter", "continuer", "continuar"];
	const MENU_NEW_TEXTS = ["new", "new game", "nowa", "neu"];

	function menuControlForLeaf(leaf) {
		if (!leaf) return null;
		const expectedText = (leaf.textContent || "").trim().toLowerCase();
		let best = null;
		let bestScore = -1;
		let element = leaf;
		for (let depth = 0; element && element !== document.body && depth < 6; depth++, element = element.parentElement) {
			if ((element.textContent || "").trim().toLowerCase() !== expectedText) break;
			const bounds = element.getBoundingClientRect();
			if (bounds.width < 20 || bounds.width > 500 || bounds.height < 15 || bounds.height > 56) continue;
			const style = getComputedStyle(element);
			const painted = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent" || style.backgroundImage !== "none" || style.boxShadow !== "none";
			const score = (painted ? 1000000 : 0) + bounds.width * bounds.height;
			if (score > bestScore) { best = element; bestScore = score; }
		}
		return best || leaf;
	}
	function findMenuLeaf(texts) {
		const all = document.body.querySelectorAll("div,button,span,a,p");
		let best = null;
		let bestArea = -1;
		for (const el of all) {
			if (el.id && el.id.indexOf("smp-") === 0) continue;
			if (el.closest && (el.closest("#smp-hud") || el.closest("#smp-lobby") || el.closest("#smp-mp-btn"))) continue;
			const txt = (el.textContent || "").trim().toLowerCase();
			if (!txt || txt.length > 14 || texts.indexOf(txt) < 0) continue;
			const control = menuControlForLeaf(el);
			const bounds = control && control.getBoundingClientRect();
			const area = bounds && bounds.width >= 5 && bounds.height >= 5 ? bounds.width * bounds.height : -1;
			if (area > bestArea) { best = el; bestArea = area; }
		}
		return best;
	}
	function lowestCommonMenuAncestor(first, second) {
		if (!first || !second) return null;
		const ancestors = new Set();
		for (let element = first; element; element = element.parentElement) ancestors.add(element);
		for (let element = second; element; element = element.parentElement) if (ancestors.has(element)) return element;
		return null;
	}
	function directMenuBranch(commonAncestor, descendant) {
		if (!commonAncestor || !descendant) return null;
		let branch = descendant;
		while (branch.parentElement && branch.parentElement !== commonAncestor) branch = branch.parentElement;
		return branch.parentElement === commonAncestor ? branch : null;
	}
	function menuRowBranch(control) {
		if (!control) return null;
		const expectedText = (control.textContent || "").trim();
		let branch = control;
		while (branch.parentElement && branch.parentElement !== document.body) {
			const parent = branch.parentElement;
			if (parent.children.length !== 1 || (parent.textContent || "").trim() !== expectedText) break;
			branch = parent;
		}
		return branch;
	}
	function nativeMenuLabelMetrics(control) {
		const controlBounds = control.getBoundingClientRect();
		const expectedText = (control.textContent || "").trim();
		const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const textNode = walker.currentNode;
			if ((textNode.nodeValue || "").trim() !== expectedText) continue;
			const range = document.createRange();
			range.selectNodeContents(textNode);
			const textBounds = range.getBoundingClientRect();
			return {
				style: getComputedStyle(control),
				leftInset: Math.max(0, Math.round(textBounds.left - controlBounds.left) - 4),
				topInset: textBounds.top - controlBounds.top,
				textNode
			};
		}
		return { style: getComputedStyle(control), leftInset: 11, topInset: 0, textNode: null };
	}
	function cloneNativeMenuRow(sourceBranch, sourceControl) {
		const clone = sourceBranch.cloneNode(true);
		clone.id = "smp-mp-btn";
		clone.dataset.smpNativeMenuClone = "1";
		for (const element of clone.querySelectorAll("[id]")) element.removeAttribute("id");
		const originalLabel = (sourceControl.textContent || "").trim();
		const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
		let labelNode = null;
		while (walker.nextNode()) {
			if ((walker.currentNode.nodeValue || "").trim() === originalLabel) { labelNode = walker.currentNode; break; }
		}
		if (!labelNode) { clone.textContent = ""; labelNode = document.createTextNode(""); clone.appendChild(labelNode); }
		clone._smpLabelNode = labelNode;
		clone.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openLobby(); });
		return clone;
	}
	function resetShiftedMenuButtons() {
		for (const element of document.querySelectorAll("[data-smp-menu-shifted]")) {
			element.style.transform = element.dataset.smpOriginalTransform || "";
			delete element.dataset.smpMenuShifted;
			delete element.dataset.smpOriginalTransform;
		}
		for (const element of document.querySelectorAll("[data-smp-menu-spaced]")) {
			element.style.marginTop = element.dataset.smpOriginalMarginTop || "";
			delete element.dataset.smpMenuSpaced;
			delete element.dataset.smpOriginalMarginTop;
		}
		for (const element of document.querySelectorAll("[data-smp-menu-padded]")) {
			element.style.paddingTop = element.dataset.smpOriginalPaddingTop || "";
			delete element.dataset.smpMenuPadded;
			delete element.dataset.smpOriginalPaddingTop;
		}
	}
	function addMenuRowSpace(row, amount) {
		if (!row) return;
		row.dataset.smpOriginalMarginTop = row.style.marginTop || "";
		row.dataset.smpMenuSpaced = "1";
		const currentMargin = parseFloat(getComputedStyle(row).marginTop) || 0;
		row.style.marginTop = currentMargin + amount + "px";
	}
	function alignMenuRowLabelTop(row, labelMetrics, desiredTop) {
		if (!row || !labelMetrics || !labelMetrics.textNode) return;
		const range = document.createRange();
		range.selectNodeContents(labelMetrics.textNode);
		const correction = desiredTop - range.getBoundingClientRect().top;
		if (Math.abs(correction) < 0.5) return;
		row.style.marginTop = (parseFloat(row.style.marginTop) || 0) + correction + "px";
	}
	function addCompactMenuRowPadding(row, amount) {
		if (!row || amount <= 0) return;
		row.dataset.smpOriginalPaddingTop = row.style.paddingTop || "";
		row.dataset.smpMenuPadded = "1";
		const currentPadding = parseFloat(getComputedStyle(row).paddingTop) || 0;
		row.style.paddingTop = currentPadding + amount + "px";
	}
	function shiftMenuButtonsBelow(anchorButton, amount) {
		const anchorBounds = anchorButton.getBoundingClientRect();
		const labels = MENU_LEAF_TEXTS.concat(MENU_ANCHOR_TEXTS, ["new", "load"]);
		const shiftedControls = new Set();
		for (const leaf of document.body.querySelectorAll("div,button,span,a,p")) {
			const text = (leaf.textContent || "").trim().toLowerCase();
			if (labels.indexOf(text) < 0) continue;
			const source = menuControlForLeaf(leaf);
			if (!source || shiftedControls.has(source)) continue;
			shiftedControls.add(source);
			const bounds = source.getBoundingClientRect();
			if (bounds.top <= anchorBounds.top || Math.abs(bounds.left - anchorBounds.left) > 160) continue;
			source.dataset.smpOriginalTransform = source.style.transform || "";
			source.dataset.smpMenuShifted = "1";
			source.style.transform = (source.dataset.smpOriginalTransform ? source.dataset.smpOriginalTransform + " " : "") + "translateY(" + amount + "px)";
		}
	}

	function ensureMenuUi(state) {
		const now = performance.now();
		if (now - (sandustryMP._menuUiT || 0) < 500) return;
		sandustryMP._menuUiT = now;
		const inMenu = state.store && state.store.scene && state.store.scene.active === 1;
		let btn = document.getElementById("smp-mp-btn");
		if (!inMenu) {
			resetShiftedMenuButtons();
			if (btn) btn.remove();
			if (sandustryMP._lobbyOpen) closeLobby();
			return;
		}
		// Main-menu windows keep the underlying New/Load controls mounted and merely
		// dim them. Keep the launcher at its last valid menu position and lower it
		// beneath the modal; do not mistake a modal heading such as "Load Game" for
		// the native Load button and recalculate its geometry around that heading.
		const menuWindows = state.session && state.session.windows;
		const menuWindowOpen = menuWindows && Object.values(menuWindows).some((windowState) => windowState && windowState.open);
		if (menuWindowOpen) {
			if (btn) btn.style.zIndex = "10";
			return;
		}
		resetShiftedMenuButtons();
		if (btn && btn.dataset.smpFixedMenuClone !== "4") { btn.remove(); btn = null; }
		const continueLeaf = findMenuLeaf(MENU_CONTINUE_TEXTS);
		const newLeaf = findMenuLeaf(MENU_NEW_TEXTS);
		const loadLeaf = findMenuLeaf(["load", "load game", "wczytaj", "laden", "charger", "cargar"]);
		const continueControl = menuControlForLeaf(continueLeaf);
		const newControl = menuControlForLeaf(newLeaf);
		const loadControl = menuControlForLeaf(loadLeaf);
		const modsControl = menuControlForLeaf(findMenuLeaf(["mods", "mody"]));
		const mapsControl = menuControlForLeaf(findMenuLeaf(["maps", "mapy", "karten", "cartes", "mapas"]));
		const styleControl = newControl || loadControl || continueControl;
		let anchor = continueControl && newControl ? continueControl : newControl && loadControl ? newControl : modsControl || mapsControl;
		// element found but invisible/null (subscreen renders something else) = no anchor
		if (anchor) {
			const ar = anchor.getBoundingClientRect();
			if (ar.width < 5 || ar.height < 5) anchor = null;
		}
		if (anchor) sandustryMP._menuAnchorSeen = true;
		// PODMENU (Wczytaj/Opcje/Mody...) - ZNIKAJ main menu buttons with DOM, and fallback showed
		// our button above the subscreen (report Psychospark89). If we've seen the anchor before,
		// A missing anchor means a submenu, so hide the button. The fallback applies only to unknown languages.
		if (!anchor && sandustryMP._menuAnchorSeen) { if (btn) btn.remove(); if (sandustryMP._lobbyOpen) renderLobby(false); return; }
		const newBounds = newControl && newControl.getBoundingClientRect();
		const loadBounds = loadControl && loadControl.getBoundingClientRect();
		const standardGap = newBounds && loadBounds ? Math.max(2, Math.round(loadBounds.top - newBounds.bottom)) : 7;
		const targetControl = continueControl && newControl ? newControl : newControl && loadControl ? loadControl : null;
		const targetRow = menuRowBranch(targetControl);
		const targetBounds = targetControl && targetControl.getBoundingClientRect();
		if (!btn && styleControl) {
			btn = document.createElement("div");
			btn.setAttribute("role", "button");
			btn.tabIndex = 0;
			btn.id = "smp-mp-btn";
			btn.dataset.smpFixedMenuClone = "4";
			const face = document.createElement("div");
			face.className = "relative left-0 w-full overflow-hidden text-white transition-all duration-300 pointer-events-none active:bg-opacity-75";
			face.style.display = "flex";
			face.style.alignItems = "center";
			face.style.width = "100%";
			face.style.height = "100%";
			face.style.boxSizing = "border-box";
			face.style.borderRadius = "0 8px 0 8px";
			face.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.28)";
			const firstLetter = document.createElement("span");
			firstLetter.className = "transition-colors";
			const remainingLabel = document.createElement("span");
			remainingLabel.className = "text-white";
			face.append(firstLetter, remainingLabel);
			btn.appendChild(face);
			btn._smpFace = face;
			btn._smpFirstLetter = firstLetter;
			btn._smpRemainingLabel = remainingLabel;
			btn.addEventListener("click", openLobby);
			btn.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openLobby(); }
			});
			btn.addEventListener("mouseenter", () => {
				face.style.left = "8px";
				face.style.transitionDuration = "0ms";
				face.style.borderColor = "transparent";
				face.style.background = "rgba(8, 8, 4, 0.94)";
				firstLetter.style.color = "#ffe700";
			});
			btn.addEventListener("mouseleave", () => {
				face.style.left = "0";
				face.style.transitionDuration = "300ms";
				face.style.borderColor = btn._smpNativeBorderColor;
				face.style.background = btn._smpNativeBackground;
				firstLetter.style.color = "";
			});
			document.body.appendChild(btn);
		}
		if (!btn) { if (sandustryMP._lobbyOpen) renderLobby(false); return; }
		const styleBounds = styleControl.getBoundingClientRect();
		const buttonBounds = targetBounds || styleBounds;
		const visibleButtonWidth = Math.max(160, Math.round(buttonBounds.width));
		const visibleButtonHeight = Math.max(30, Math.round(buttonBounds.height));
		const nativeLabel = nativeMenuLabelMetrics(styleControl);
		const targetLabel = targetControl ? nativeMenuLabelMetrics(targetControl) : null;
		const nativeTypography = nativeLabel.style;
		const nativeLeftInset = Math.max(6, Math.round(visibleButtonHeight * 0.28));
		let buttonTop;
		if (targetControl && targetRow && targetBounds) {
			const compactTopGap = !continueControl
				? Math.max(0, Math.min(2, Math.round((220 - visibleButtonWidth) * 0.02)))
				: 0;
			buttonTop = continueControl && newControl
				? continueControl.getBoundingClientRect().bottom + standardGap
				: newControl.getBoundingClientRect().bottom + standardGap + compactTopGap;
			addMenuRowSpace(targetRow, visibleButtonHeight + standardGap);
			alignMenuRowLabelTop(targetRow, targetLabel, buttonTop + visibleButtonHeight + standardGap + targetLabel.topInset);
			const compactPadding = Math.max(0, Math.min(15, Math.round((220 - visibleButtonWidth) * 0.29)));
			addCompactMenuRowPadding(targetRow, compactPadding);
		} else {
			const modsBounds = modsControl && modsControl.getBoundingClientRect();
			const mapsBounds = mapsControl && mapsControl.getBoundingClientRect();
			buttonTop = Math.max(modsBounds ? modsBounds.bottom : 0, mapsBounds ? mapsBounds.bottom : 0) + standardGap;
		}
		// Geometry stays on the detached outer control so the native hover shift only
		// moves its inner face and cannot disturb the surrounding React menu.
		btn.className = "group cursor-pointer pointer-events-auto";
		btn.style.setProperty("position", "fixed", "important");
		btn.style.zIndex = "99999";
		btn.style.margin = "0";
		btn.style.transform = "none";
		btn.style.boxSizing = "border-box";
		btn.style.display = "block";
		btn.style.cursor = "pointer";
		btn.style.userSelect = "none";
		btn.style.whiteSpace = "nowrap";
		btn.style.setProperty("display", "flex", "important");
		btn.style.setProperty("visibility", "visible", "important");
		btn.style.setProperty("opacity", "1", "important");
		btn.style.setProperty("pointer-events", "auto", "important");
		btn.style.background = "transparent";
		btn.style.border = "0";
		btn.style.padding = "0";
		btn.style.left = Math.round(buttonBounds.left) + "px";
		btn.style.top = Math.round(buttonTop) + "px";
		btn.style.width = visibleButtonWidth + "px";
		btn.style.height = visibleButtonHeight + "px";
		// Match the native menu's responsive typography instead of pinning the
		// Multiplayer label to a desktop-sized Tailwind font and line height.
		if (btn._smpFace) {
			btn._smpFace.style.fontFamily = nativeTypography.fontFamily;
			btn._smpFace.style.fontSize = Math.max(12, Math.round(visibleButtonHeight * 0.72)) + "px";
			btn._smpFace.style.fontWeight = nativeTypography.fontWeight;
			btn._smpFace.style.lineHeight = "1";
			btn._smpFace.style.letterSpacing = nativeTypography.letterSpacing;
			btn._smpFace.style.paddingLeft = nativeLeftInset + "px";
			btn._smpFace.style.paddingRight = nativeLeftInset + "px";
			btn._smpFace.style.textTransform = nativeTypography.textTransform;
		}
		// Keep connection state visible without opening the lobby (TCentraL: "no real way to know if
		// you're connected") - green dot and frame when you are hosting/connected
		const conn = sandustryMP.net.role !== "idle";
		const label = t("mp_btn") + (conn ? "  ●" : "");
		if (btn._smpFirstLetter) btn._smpFirstLetter.textContent = label.charAt(0);
		if (btn._smpRemainingLabel) btn._smpRemainingLabel.textContent = label.slice(1);
		// Multiplayer always follows the primary Continue/New action, so it uses the
		// same secondary appearance as Load and Options in both menu layouts.
		btn._smpNativeBorderColor = "rgba(100, 116, 139, 0.68)";
		btn._smpNativeBackground = "rgba(0, 0, 0, 0.72)";
		if (btn._smpFace && !btn.matches(":hover")) {
			btn._smpFace.style.border = "1px solid " + btn._smpNativeBorderColor;
			btn._smpFace.style.background = btn._smpNativeBackground;
		}
		if (conn) {
			btn.style.setProperty("color", "#aef5c8", "important");
			if (btn._smpFace && !btn.matches(":hover")) btn._smpFace.style.borderColor = "#4c8";
		} else {
			btn.style.removeProperty("color");
		}
		if (sandustryMP._lobbyOpen) renderLobby(false);
	}

	function openLobby() {
		sandustryMP._lobbyOpen = true; sandustryMP._lobbyView = null;
		try { net.status().then((s) => { sandustryMP._myNick = s.myNick || sandustryMP._myNick; }).catch(() => {}); } catch (e) {}
		let ov = document.getElementById("smp-lobby");
		if (!ov) {
			ov = document.createElement("div");
			ov.id = "smp-lobby";
			ov.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(2,10,18,.72);display:flex;align-items:center;justify-content:center";
			ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeLobby(); });
			document.body.appendChild(ov);
		}
		renderLobby(true);
	}
	function closeLobby() {
		sandustryMP._lobbyOpen = false; sandustryMP._lobbyView = null;
		const ov = document.getElementById("smp-lobby");
		if (ov) ov.remove();
	}

	function lbBtn(label, desc, primary) {
		const b = document.createElement("div");
		b.style.cssText = "cursor:pointer;margin:7px 0;padding:10px 14px;border-radius:4px;border:1px solid rgba(255,255,255,.14);" +
			"background:" + (primary ? "#1d4a6b" : "#14283a") + ";user-select:none";
		b.onmouseenter = () => { b.style.background = primary ? "#276089" : "#1c3850"; };
		b.onmouseleave = () => { b.style.background = primary ? "#1d4a6b" : "#14283a"; };
		const l1 = document.createElement("div");
		l1.style.cssText = "font-weight:700;font-size:16px;color:#fff"; l1.textContent = label;
		b.appendChild(l1);
		if (desc) {
			const l2 = document.createElement("div");
			l2.style.cssText = "font-size:11px;color:#9fb6c9;margin-top:2px"; l2.textContent = desc;
			b.appendChild(l2);
		}
		return b;
	}

	function lbInput(placeholder, value, width) {
		const input = document.createElement("input");
		input.placeholder = placeholder; input.value = value; input.spellcheck = false;
		input.style.cssText = "width:" + width + "px;background:#0b1620;color:#dfe9f2;border:1px solid #33506a;border-radius:3px;font:13px monospace;padding:5px 7px";
		input.addEventListener("keydown", (event) => event.stopPropagation()); // the keys do not leak into the game
		input.addEventListener("keyup", (event) => event.stopPropagation());
		return input;
	}

	async function loadLatestAndPlay() {
		try {
			const saves = await window.electron.getSaveFiles();
			if (!saves || !saves.length) { setStatus(t("no_saves"), "#f66"); return; }
			const ts = (s) => s.timestamp || s.updatedAt || s.savedAt || s.time || s.date || 0;
			saves.sort((a, b) => (ts(a) > ts(b) ? 1 : -1));
			const save = saves[saves.length - 1];
			if (!(sandustryMP.gameApi && sandustryMP.gameApi.game && typeof sandustryMP.gameApi.game.load === "function" && sandustryMP.state)) { setStatus(t("error", "game.load?"), "#f66"); return; }
			closeLobby();
			log("lobby: loading last save:", save.name || save.id);
			const lr = await sandustryMP.gameApi.game.load(sandustryMP.state, save.id);
			if (lr && lr.success === false) throw new Error(lr.error || "load failed");
			// auto-send save to players will be done by host frame hook (auto-send when host in the world)
		} catch (e) { setStatus(t("error", e.message), "#f66"); log("lobby loadLatestAndPlay error:", e.message); }
	}

	function renderLobby(force) {
		const ov = document.getElementById("smp-lobby");
		if (!ov || !sandustryMP._lobbyOpen) return;
		const view = sandustryMP.net.role === "idle" ? "start" : "lobby";
		if (force || sandustryMP._lobbyView !== view) {
			sandustryMP._lobbyView = view;
			ov.innerHTML = "";
			const p = document.createElement("div");
			p.style.cssText = "width:540px;max-width:92vw;max-height:86vh;overflow:auto;background:rgba(8,20,30,.97);" +
				"border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:20px 26px;color:#dfe9f2;box-shadow:0 10px 40px rgba(0,0,0,.6)";
			p.style.fontFamily = sandustryMP._gameFont || "sans-serif";
			// header + close
			const head = document.createElement("div");
			head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px";
			const h1 = document.createElement("div");
			h1.style.cssText = "font-weight:800;font-size:22px;letter-spacing:1px;color:#ffb454"; h1.textContent = t("lb_title");
			const x = document.createElement("div");
			x.style.cssText = "cursor:pointer;color:#9fb6c9;font-size:20px;padding:0 4px"; x.textContent = t("lb_close");
			x.onclick = closeLobby;
			head.appendChild(h1); head.appendChild(x); p.appendChild(head);
			const sub = document.createElement("div");
			sub.style.cssText = "font-size:11px;color:#7d95a8;margin-bottom:12px";
			sub.textContent = t("lb_sub") + " — " + VER;
			p.appendChild(sub);

			if (view === "start") {
				// player nickname (feedback TCentraL: on LAN everyone is "Player") - saved in localStorage,
				// broadcast via hello protocol on join / to new peers
				const nickRow = document.createElement("div");
				nickRow.style.cssText = "margin:0 0 8px;font-size:12px;color:#9fb6c9";
				const nickLbl = document.createElement("span"); nickLbl.textContent = t("lb_nick") + ":  ";
				const nickIn = lbInput(t("lb_nick"), sandustryMP._nickCustom || sandustryMP._myNick || "", 150);
				nickIn.maxLength = 24;
				nickIn.addEventListener("input", () => {
					const v = nickIn.value.trim().slice(0, 24);
					sandustryMP._nickCustom = v || null;
					try { if (v) localStorage.setItem("smp_nick", v); else localStorage.removeItem("smp_nick"); } catch (e) {}
					if (v) sandustryMP._myNick = v;
				});
				nickRow.appendChild(nickLbl); nickRow.appendChild(nickIn);
				p.appendChild(nickRow);
				const bSteam = lbBtn(t("btn_host") /* Host (Steam) */, t("lb_host_steam_d"), true);
				bSteam.onclick = async () => {
					setStatus(t("creating_lobby"));
					try { const r = await net.hostSteam(); if (!r.ok) setStatus(t("error", r.error), "#f66"); }
					catch (e) { setStatus(t("error", e.message), "#f66"); log("lobby hostSteam error:", e.message); }
					renderLobby(true);
				};
				p.appendChild(bSteam);
				const bLan = lbBtn(t("btn_host_lan"), t("lb_host_lan_d"), false);
				bLan.onclick = async () => {
					try { const r = await net.hostWs(27777); if (!r.ok) setStatus(t("error", r.error), "#f66"); }
					catch (e) { setStatus(t("error", e.message), "#f66"); log("lobby hostWs error:", e.message); }
					renderLobby(true);
				};
				p.appendChild(bLan);
				// Include LAN: button + address fields
				const bJoin = lbBtn(t("btn_join_lan"), t("lb_join_lan_d"), false);
				const row = document.createElement("div");
				row.style.cssText = "display:none;margin:2px 0 6px;padding:0 2px";
				const ip = lbInput("IP", "127.0.0.1", 170);
				const port = lbInput("port", "27777", 62); port.maxLength = 5;
				const go = document.createElement("button");
				go.textContent = t("btn_connect");
				go.style.cssText = "margin-left:6px;background:#1d4a6b;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:3px;font:600 13px inherit;cursor:pointer;padding:5px 12px";
				const doJoin = async () => {
					let h = (ip.value || "").trim(); let pr = (port.value || "").trim();
					if (h.indexOf(":") >= 0) { const a = h.split(":"); h = a[0]; if (a[1]) { pr = a[1]; port.value = pr; } ip.value = h; }
					if (!h) { ip.focus(); return; }
					const pn = parseInt(pr || "27777", 10);
					if (!(pn > 0 && pn < 65536)) { port.focus(); port.select(); return; }
					setStatus(t("creating_lobby"));
					const r = await net.joinWs(h, pn);
					if (!r.ok) setStatus(t("error", r.error), "#f66");
					renderLobby(true);
				};
				for (const el of [ip, port]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doJoin(); } });
				go.onclick = doJoin;
				row.appendChild(ip); row.appendChild(port); row.appendChild(go);
				bJoin.onclick = () => { row.style.display = row.style.display === "none" ? "block" : "none"; if (row.style.display === "block") { ip.focus(); ip.select(); } };
				p.appendChild(bJoin); p.appendChild(row);
				const bId = lbBtn(t("btn_join_id"), t("lb_join_id_d"), false);
				bId.onclick = async () => {
					let id; try { id = (await navigator.clipboard.readText()).trim(); } catch (e) { setStatus(t("error", "clipboard: " + e.message), "#f66"); return; }
					if (!id || !/^\d{5,}$/.test(id)) { setStatus(t("clipboard_no_id"), "#f66"); return; }
					setStatus(t("creating_lobby"));
					const r = await net.joinSteam(id);
					if (!r.ok) setStatus(t("error", r.error), "#f66");
					renderLobby(true);
				};
				p.appendChild(bId);
				const hint = document.createElement("div");
				hint.style.cssText = "margin-top:10px;font-size:11px;color:#7d95a8"; hint.textContent = t("lb_hint");
				p.appendChild(hint);
			} else {
				// LOBBY: role badge + status + lobby id + invite + player list + world + disconnect
				const badge = document.createElement("div");
				const trName = sandustryMP.net.transport === "steam" ? "Steam" : "LAN";
				badge.style.cssText = "font-weight:800;font-size:15px;margin:2px 0 4px;color:" + (sandustryMP.net.role === "host" ? "#5f5" : "#6cf");
				badge.textContent = sandustryMP.net.role === "host" ? t("badge_host", trName) : t("badge_client", trName);
				p.appendChild(badge);
				if (sandustryMP.net.role === "host") {
					const steps = document.createElement("div");
					steps.style.cssText = "font-size:12px;color:#ffd27a;margin:0 0 6px";
					steps.textContent = t("lb_steps");
					p.appendChild(steps);
				}
				const st2 = document.createElement("div");
				st2.id = "smp-lb-status"; st2.style.cssText = "font-size:12px;color:#ffd27a;margin:2px 0 8px";
				p.appendChild(st2);
				if (sandustryMP.net.role === "host" && sandustryMP.net.transport === "steam") {
					const inv = lbBtn(t("lb_invite"), null, true);
					inv.onclick = () => net.invite();
					p.appendChild(inv);
					const idRow = document.createElement("div");
					idRow.style.cssText = "font-size:12px;color:#9f9;margin:4px 0 8px;cursor:pointer";
					idRow.id = "smp-lb-id"; idRow.title = "Click to copy";
					idRow.onclick = async () => {
						if (!sandustryMP.net.lobbyId) return;
						try { await navigator.clipboard.writeText(sandustryMP.net.lobbyId); idRow.textContent = t("lb_id") + ": " + t("lb_copied"); } catch (e) {}
					};
					p.appendChild(idRow);
				}
				const plH = document.createElement("div");
				plH.style.cssText = "font-weight:700;font-size:14px;color:#fff;margin-top:6px"; plH.textContent = t("lb_players");
				p.appendChild(plH);
				const pl2 = document.createElement("div");
				pl2.id = "smp-lb-players"; pl2.style.cssText = "margin:4px 0 10px;font-size:13px;line-height:1.6";
				p.appendChild(pl2);
				if (sandustryMP.net.role === "host") {
					const play = lbBtn(t("lb_play_last"), t("lb_play_note"), true);
					play.onclick = loadLatestAndPlay;
					p.appendChild(play);
					// selecting KONKRETNEGO save (feedback TCentraL: "maybe do: New map option, load map option")
					const pick = lbBtn(t("lb_pick_save"), t("lb_pick_save_d"), false);
					const list = document.createElement("div");
					list.style.cssText = "display:none;max-height:180px;overflow:auto;margin:2px 0 6px;border:1px solid rgba(255,255,255,.1);border-radius:4px";
					pick.onclick = async () => {
						if (list.style.display !== "none") { list.style.display = "none"; return; }
						list.style.display = "block"; list.innerHTML = "";
						try {
							const saves = await window.electron.getSaveFiles();
							const tsv = (s) => s.timestamp || s.updatedAt || s.savedAt || s.time || s.date || 0;
							(saves || []).sort((a, b) => (tsv(a) < tsv(b) ? 1 : -1));
							for (const sv of (saves || []).slice(0, 25)) {
								const row = document.createElement("div");
								row.style.cssText = "cursor:pointer;padding:5px 10px;border-bottom:1px solid rgba(255,255,255,.06);color:#cfe0ee;font-size:13px";
								const tv = tsv(sv);
								row.textContent = (sv.name || sv.id) + (tv > 1e12 ? "   ·   " + new Date(tv).toLocaleString() : "");
								row.onmouseenter = () => { row.style.background = "#1c3850"; };
								row.onmouseleave = () => { row.style.background = ""; };
								row.onclick = async () => {
									closeLobby();
									try {
										log("lobby: loading selected save:", sv.name || sv.id);
										const lr = await sandustryMP.gameApi.game.load(sandustryMP.state, sv.id);
										if (lr && lr.success === false) throw new Error(lr.error || "load failed");
									} catch (e) { setStatus(t("error", e.message), "#f66"); }
								};
								list.appendChild(row);
							}
							if (!list.childElementCount) list.textContent = t("no_saves");
						} catch (e) { list.textContent = "error: " + e.message; }
					};
					p.appendChild(pick); p.appendChild(list);
					const newNote = document.createElement("div");
					newNote.style.cssText = "font-size:11px;color:#7d95a8;margin:0 0 8px";
					newNote.textContent = t("lb_new_note");
					p.appendChild(newNote);
				} else {
					const w8 = document.createElement("div");
					w8.style.cssText = "font-size:12px;color:#9fb6c9;margin:6px 0 10px"; w8.textContent = t("lb_wait_host");
					p.appendChild(w8);
				}
				const dc = lbBtn(t("lb_disconnect"), null, false);
				dc.onclick = () => { setClientPaused(false); net.stop(); renderLobby(true); };
				p.appendChild(dc);
			}
			ov.appendChild(p);
		}
		// dynamic refresh (no reconstruction - inputs do not lose focus)
		if (view === "lobby") {
			const st2 = document.getElementById("smp-lb-status");
			if (st2) {
				const hudSt = document.getElementById("smp-status");
				st2.textContent = (hudSt && hudSt.textContent) || "";
			}
			const idRow = document.getElementById("smp-lb-id");
			if (idRow && sandustryMP.net.lobbyId && idRow.textContent.indexOf(t("lb_copied")) < 0) {
				const id = String(sandustryMP.net.lobbyId);
				idRow.textContent = t("lb_id") + ": ●●●●●●" + id.slice(-3) + "  📋 (" + t("lb_copy") + ")";
			}
			const pl2 = document.getElementById("smp-lb-players");
			if (pl2) {
				pl2.innerHTML = "";
				const mk = (nick, info, ok) => {
					const r = document.createElement("div");
					const dot = document.createElement("span");
					dot.textContent = "● "; dot.style.color = ok ? "#5f5" : "#f66";
					const nm = document.createElement("span"); nm.textContent = nick; nm.style.color = "#fff";
					const inf = document.createElement("span"); inf.textContent = "  " + info; inf.style.cssText = "color:#7d95a8;font-size:11px";
					r.appendChild(dot); r.appendChild(nm); r.appendChild(inf);
					return r;
				};
				pl2.appendChild(mk(sandustryMP._myNick || "Player", "(" + t("lb_you") + ") " + VER, true));
				for (const [, pr] of sandustryMP.peers) pl2.appendChild(mk(pr.nick || "?", pr.modVer || "?", !pr.modVer || pr.modVer === VER));
			}
		}
	}
			return { ensureMenuUi, renderLobby };
		}
	};
})();
