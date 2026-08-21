// ============================================================================
// SandustryMP — co-op multiplayer mod for Sandustry
// Author / Autor: KAMIL PADULA
// Networking core (Electron main process).
// Transports: Steam P2P (internet, zero-config via lobby + overlay invites)
//             and a minimal dependency-free WebSocket (LAN / local testing).
// All network state lives here because the renderer reloads between scenes.
// ============================================================================

'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TAG = '[SandustryMP:net]';
let fileLog = null;
try { fileLog = require('./logger').createLogger('SandustryMP'); } catch (e) { /* Game logger unavailable. */ }
const log = (...values) => {
  const line = values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value, (key, nestedValue) => (typeof nestedValue === 'bigint' ? String(nestedValue) : nestedValue)))).join(' ');
  console.log(TAG, line);
  if (fileLog) fileLog.info(line);
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTO_VER = 7;
const JOIN_ACK_TIMEOUT_MS = 250;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const networkState = {
  getMainWindow: null,
  steam: null,          // steamworks client (z steam.js gry)
  role: 'idle',         // idle | host | client
  transport: null,      // 'steam' | 'ws'
  lobby: null,          // Steam lobby (host and client)
  peers: new Map(),     // id(string) -> peer {id, kind:'steam'|'ws', steamId64?, sock?, nick}
  wsServer: null,
  wsClient: null,       // WS client socket (client role, ws transport)
  p2pPoll: null,
  myNick: 'Player',
  myId: 'local',
};

function sendRenderer(channel, payload) {
  try {
    const win = networkState.getMainWindow && networkState.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (e) { /* The window is reloading. */ }
}
const emitEvent = (kind, data) => { log('event:', kind, data ? JSON.stringify(data).slice(0, 200) : ''); sendRenderer('smp:event', { kind, ...data }); };
const emitMsg = (from, message) => sendRenderer('smp:msg', { from, msg: message });

// ---------------------------------------------------------------------------
// Minimalny WebSocket (RFC6455) - server and client on raw net, no dependencies
// ---------------------------------------------------------------------------
function wsEncodeFrame(payload, mask) {
  const data = Buffer.from(payload, 'utf8');
  const payloadLength = data.length;
  let header;
  if (payloadLength < 126) header = Buffer.from([0x81, payloadLength | (mask ? 0x80 : 0)]);
  else if (payloadLength < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126 | (mask ? 0x80 : 0); header.writeUInt16BE(payloadLength, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127 | (mask ? 0x80 : 0); header.writeBigUInt64BE(BigInt(payloadLength), 2); }
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([header, key, masked]);
}

// Parser frame stream; onText(str), returns the feed(chunk) function
function wsFrameParser(socket, onText) {
  let bufferedData = Buffer.alloc(0);
  return (chunk) => {
    bufferedData = Buffer.concat([bufferedData, chunk]);
    while (true) {
      if (bufferedData.length < 2) return;
      const isFinalFrame = (bufferedData[0] & 0x80) !== 0;
      const opcode = bufferedData[0] & 0x0f;
      const masked = (bufferedData[1] & 0x80) !== 0;
      let payloadLength = bufferedData[1] & 0x7f;
      let payloadOffset = 2;
      if (payloadLength === 126) { if (bufferedData.length < 4) return; payloadLength = bufferedData.readUInt16BE(2); payloadOffset = 4; }
      else if (payloadLength === 127) { if (bufferedData.length < 10) return; payloadLength = Number(bufferedData.readBigUInt64BE(2)); payloadOffset = 10; }
      const maskKey = masked ? bufferedData.subarray(payloadOffset, payloadOffset + 4) : null;
      if (masked) payloadOffset += 4;
      if (bufferedData.length < payloadOffset + payloadLength) return;
      let payload = bufferedData.subarray(payloadOffset, payloadOffset + payloadLength);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]; }
      bufferedData = bufferedData.subarray(payloadOffset + payloadLength);
      if (opcode === 8) { try { socket.end(); } catch (e) {} return; }
      if (opcode === 9) { try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (e) {} continue; }
      if (opcode === 1 && isFinalFrame) onText(payload.toString('utf8'));
      // fragmentation and binary are omitted - the protocol uses short text frames
    }
  };
}

function startWsServer(port) {
  stopNetworking('restart');
  networkState.role = 'host'; networkState.transport = 'ws';
  networkState.wsServer = net.createServer((sock) => {
    let upgraded = false;
    let headerBuf = Buffer.alloc(0);
    const peerId = 'ws:' + sock.remoteAddress + ':' + sock.remotePort;
    sock.on('data', (chunk) => {
      if (upgraded) return;
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = headerBuf.toString('utf8', 0, idx);
      const m = /Sec-WebSocket-Key:\s*(.+)\r\n/i.exec(head + '\r\n');
      if (!m || !/upgrade/i.test(head)) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const accept = crypto.createHash('sha1').update(m[1].trim() + WS_GUID).digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      upgraded = true;
      const peer = { id: peerId, kind: 'ws', sock, nick: '?', admitted: false };
      networkState.peers.set(peerId, peer);
      const feed = wsFrameParser(sock, (text) => handleIncoming(peerId, text));
      const rest = headerBuf.subarray(idx + 4);
      sock.on('data', feed);
      if (rest.length) feed(rest);
    });
    sock.on('close', () => {
      const peer = networkState.peers.get(peerId);
      if (networkState.peers.delete(peerId) && peer && peer.admitted) emitEvent('peer-disconnected', { id: peerId });
    });
    sock.on('error', () => {});
  });
  networkState.wsServer.on('error', (e) => emitEvent('error', { where: 'ws-server', message: e.message }));
  networkState.wsServer.listen(port, () => emitEvent('hosting', { transport: 'ws', port }));
}

function joinWs(host, port, _retry) {
  stopNetworking('restart');
  networkState.role = 'client'; networkState.transport = 'ws';
  const retryCount = _retry || 0;
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, host, () => {
    sock.write('GET / HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  networkState.wsClient = sock;
  let upgraded = false;
  let headerBuf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    if (upgraded) return;
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    if (!/ 101 /.test(headerBuf.toString('utf8', 0, idx))) { emitEvent('error', { where: 'ws-join', message: 'handshake failed' }); sock.end(); return; }
    upgraded = true;
    const peer = { id: 'host', kind: 'ws', sock, nick: 'Host', admitted: false };
    networkState.peers.set('host', peer);
    const feed = wsFrameParser(sock, (text) => handleIncoming('host', text));
    const rest = headerBuf.subarray(idx + 4);
    sock.on('data', feed);
    if (rest.length) feed(rest);
    beginClientJoin(peer, { transport: 'ws', host, port });
  });
  sock.on('close', () => {
    networkState.peers.delete('host');
    emitEvent('peer-disconnected', { id: 'host' });
    // AUTO-RECONNECT (LAN): we resurrect a broken link every 3 seconds. Licznik retries go through the _retry parameter
    // (will survive the next sockets!). Udany handshake = stable link → future disconnection has 5 attempts again.
    // Stop user / other connection interrupts in the meantime (role/transport/peers check).
    if (networkState.role === 'client' && networkState.transport === 'ws' && networkState.wsClient === sock) {
      const next = upgraded ? 1 : retryCount + 1; // after a stable connection, count from 1; after a failed attempt +1
      if (next > 5) { emitEvent('error', { where: 'ws-join', message: 'reconnect failed after 5 tries' }); return; }
      setTimeout(() => {
        if (networkState.role !== 'client' || networkState.transport !== 'ws' || networkState.peers.size > 0) return;
        log('WS reconnect attempt', next, '/5 →', host + ':' + port);
        emitEvent('reconnecting', { transport: 'ws', attempt: next });
        try { joinWs(host, port, next); } catch (e) {}
      }, 3000);
    }
  });
  sock.on('error', (e) => emitEvent('error', { where: 'ws-join', message: e.message }));
}

// ---------------------------------------------------------------------------
// Steam P2P
// ---------------------------------------------------------------------------
function ensureP2pPoll() {
  if (networkState.p2pPoll) return;
  networkState.p2pPoll = setInterval(() => {
    try {
      const steamNetworking = networkState.steam.networking;
      let packetSize;
      let processedPackets = 0;
      while ((packetSize = steamNetworking.isP2PPacketAvailable()) > 0 && processedPackets++ < 256) {
        const packet = steamNetworking.readP2PPacket(packetSize);
        if (!packet) break;
        const steamId = String(packet.steamId && (packet.steamId.steamId64 !== undefined ? packet.steamId.steamId64 : packet.steamId));
        const text = packet.data.toString('utf8');
        handleIncoming('steam:' + steamId, text, steamId);
      }
    } catch (e) { /* Keep the receive loop alive. */ }
  }, 15);
}

// Pola steamworks.js callbacks differ per platform: the win64 binary gives
// camelCase (lobbySteamId), binarka osx snake_case (lobby_steam_id). Bierzemy
// pierwsze zdefiniowane pole.
function pickField(object, ...keys) {
  if (!object) return undefined;
  for (const key of keys) if (object[key] !== undefined) return object[key];
  return undefined;
}

function registerSteamCallbacks() {
  const callbackApi = networkState.steam.callback;
  const SteamCallback = callbackApi.SteamCallback;
  callbackApi.register(SteamCallback.P2PSessionRequest, (data) => {
    try {
      const remoteSteamId = pickField(data, 'remote', 'steam_id_remote', 'remoteSteamId', 'remote_steam_id');
      const steamIdValue = remoteSteamId !== undefined ? remoteSteamId : data;
      const steamId64 = typeof steamIdValue === 'object' && steamIdValue !== null && steamIdValue.steamId64 !== undefined ? steamIdValue.steamId64 : steamIdValue;
      networkState.steam.networking.acceptP2PSession(BigInt(steamId64));
      log('P2P session accepted:', String(steamId64));
    } catch (e) { log('P2PSessionRequest error:', e.message, JSON.stringify(data)); }
  });
  callbackApi.register(SteamCallback.P2PSessionConnectFail, (data) => {
    emitEvent('error', { where: 'p2p', message: 'P2P connect fail', data: safeJson(data) });
    // Client: rejoin only after a second failure within 10 seconds; one transient error does not end the session.
    const now = Date.now();
    networkState._p2pFails = (networkState._p2pFails || []).filter((t) => now - t < 10000);
    networkState._p2pFails.push(now);
    if (networkState._p2pFails.length >= 2) { networkState._p2pFails = []; steamRejoin(1); }
  });
  callbackApi.register(SteamCallback.GameLobbyJoinRequested, async (data) => {
    // Znajomy clicked "Join" in Steam - we are joining the host lobby.
    try {
      const lobbyId = pickField(data, 'lobbySteamId', 'steamIdLobby', 'lobby_steam_id', 'steam_id_lobby');
      log('GameLobbyJoinRequested:', safeJson(data));
      if (lobbyId !== undefined && lobbyId !== null) await joinSteamLobby(String(typeof lobbyId === 'object' ? lobbyId.steamId64 : lobbyId));
      else emitEvent('error', { where: 'lobby-join', message: 'lobby id not found in callback payload: ' + JSON.stringify(safeJson(data)) });
    } catch (e) { emitEvent('error', { where: 'lobby-join', message: e.message }); }
  });
  callbackApi.register(SteamCallback.LobbyChatUpdate, (data) => {
    log('LobbyChatUpdate:', safeJson(data));
    if (networkState.role === 'host' && networkState.lobby) refreshLobbyMembers();
  });
}

function refreshLobbyMembers() {
  try {
    const me = String(networkState.steam.localplayer.getSteamId().steamId64);
    const members = networkState.lobby.getMembers();
    const current = new Set();
    for (const member of members) {
      const steamId = String(member.steamId64 !== undefined ? member.steamId64 : member);
      if (steamId === me) continue;
      current.add('steam:' + steamId);
      if (!networkState.peers.has('steam:' + steamId)) {
        networkState.peers.set('steam:' + steamId, { id: 'steam:' + steamId, kind: 'steam', steamId64: steamId, nick: '?', admitted: false });
      }
    }
    for (const [id, p] of networkState.peers) if (p.kind === 'steam' && !current.has(id)) { networkState.peers.delete(id); if (p.admitted) emitEvent('peer-disconnected', { id }); }
  } catch (e) { log('refreshLobbyMembers error:', e.message); }
}

// Parse a lobby ID from launch arguments. Supported forms:
//   +connect_lobby <id>   (standardowy launch param Steam)
//   steam://joinlobby/<appid>/<lobbyid>/<ownerid>
function tryJoinFromArgv(argv, source) {
  try {
    if (!Array.isArray(argv)) return false;
    let id = null;
    const i = argv.indexOf('+connect_lobby');
    if (i >= 0 && argv[i + 1]) id = argv[i + 1];
    if (!id) for (const argument of argv) { const lobbyMatch = /joinlobby\/\d+\/(\d+)/.exec(String(argument)); if (lobbyMatch) { id = lobbyMatch[1]; break; } }
    if (!id) return false;
    if (!networkState.steam) { log('argv lobby ' + id + '- Steam not initialized yet, waiting'); networkState._pendingJoin = id; return false; }
    log('Auto-join lobby z argv (' + source + '):', id);
    joinSteamLobby(String(id)).catch((e) => emitEvent('error', { where: 'argv-join', message: e.message }));
    return true;
  } catch (e) { log('tryJoinFromArgv error:', e.message); return false; }
}

async function hostSteam() {
  if (!networkState.steam) throw new Error('Steam client unavailable');
  stopNetworking('restart');
  networkState.role = 'host'; networkState.transport = 'steam';
  const { LobbyType } = networkState.steam.matchmaking;
  networkState.lobby = await networkState.steam.matchmaking.createLobby(LobbyType.FriendsOnly, 4);
  ensureP2pPoll();
  try { networkState.lobby.setJoinable(true); } catch (e) { log('setJoinable error:', e.message); }
  // Rich presence "connect" => Steam shows "Join game" in friends list
  // and passes this string as launch param to the appender.
  try { networkState.steam.localplayer.setRichPresence('connect', '+connect_lobby ' + String(networkState.lobby.id)); } catch (e) { log('setRichPresence error:', e.message); }
  emitEvent('hosting', { transport: 'steam', lobbyId: String(networkState.lobby.id) });
  return { lobbyId: String(networkState.lobby.id) };
}

// AUTO-REJOIN Steam (equivalent to WS reconnect): after losing P2P/host, we try to return to
// last lobby every 3 seconds, max 5 times. Nowe conscious connection/Stop resets the counter.
function steamRejoin(attempt) {
  if (networkState.role !== 'client' || networkState.transport !== 'steam' || !networkState.lastLobbyId) return;
  if (networkState._rejoinPending) return; // one loop at a time
  if (attempt > 5) { emitEvent('error', { where: 'steam-rejoin', message: 'rejoin failed after 5 tries' }); return; }
  networkState._rejoinPending = true;
  setTimeout(async () => {
    networkState._rejoinPending = false;
    if (networkState.role !== 'client' || networkState.transport !== 'steam') return;
    log('Steam rejoin attempt', attempt, '/5 → lobby', networkState.lastLobbyId);
    emitEvent('reconnecting', { transport: 'steam', attempt });
    try { await joinSteamLobby(networkState.lastLobbyId); } catch (e) { steamRejoin(attempt + 1); }
  }, 3000);
}

async function joinSteamLobby(lobbyIdStr) {
  if (!networkState.steam) throw new Error('Steam client unavailable');
  stopNetworking('restart');
  networkState.role = 'client'; networkState.transport = 'steam';
  networkState.lastLobbyId = lobbyIdStr;
  networkState.lobby = await networkState.steam.matchmaking.joinLobby(BigInt(lobbyIdStr));
  const owner = networkState.lobby.getOwner();
  const hostSteamId = String(owner.steamId64 !== undefined ? owner.steamId64 : owner);
  const hostPeer = { id: 'steam:' + hostSteamId, kind: 'steam', steamId64: hostSteamId, nick: 'Host', admitted: false };
  networkState.peers.set(hostPeer.id, hostPeer);
  ensureP2pPoll();
  beginClientJoin(hostPeer, { transport: 'steam', lobbyId: lobbyIdStr, hostId: hostSteamId });
  return { hostId: hostSteamId };
}

function beginClientJoin(peer, joinedEvent) {
  const nonce = crypto.randomBytes(12).toString('hex');
  peer.joinNonce = nonce;
  peer.joinedEvent = joinedEvent;
  sendToPeer(peer, { t: 'join-ping', nonce });
  peer.joinTimer = setTimeout(() => {
    if (networkState.peers.get(peer.id) !== peer || peer.admitted) return;
    sendToPeer(peer, { t: 'join-disconnect', nonce, reason: 'ack-timeout' });
    peer.rejected = true;
    emitEvent('error', { where: 'join-ack', message: 'Host did not acknowledge the join within 250 ms' });
    stopNetworking('join-ack-timeout');
  }, JOIN_ACK_TIMEOUT_MS);
}

function admitPeer(peer) {
  if (!peer || peer.admitted || peer.rejected) return;
  peer.admitted = true;
  if (peer.joinTimer) { clearTimeout(peer.joinTimer); peer.joinTimer = null; }
  if (networkState.role === 'client') {
    emitEvent('joined', peer.joinedEvent || { transport: networkState.transport });
    sendToPeer(peer, { t: 'hello', nick: networkState.myNick, ver: PROTO_VER });
  } else {
    emitEvent('peer-connected', { id: peer.id });
    sendToPeer(peer, { t: 'hello', nick: networkState.myNick, ver: PROTO_VER });
  }
}

// ---------------------------------------------------------------------------
// Local message routing
// ---------------------------------------------------------------------------
function handleIncoming(peerId, text, steamSid) {
  let message;
  try { message = JSON.parse(text); } catch (e) { return; }
  // Steam can deliver the join probe before LobbyChatUpdate registers the lobby member.
  if (steamSid && !networkState.peers.has(peerId)) {
    networkState.peers.set(peerId, { id: peerId, kind: 'steam', steamId64: steamSid, nick: '?', admitted: false });
  }
  const peer = networkState.peers.get(peerId);
  if (!peer) return;
  if (message.t === 'join-ping' && networkState.role === 'host' && !peer.rejected) {
    if (peer.joinNonce) return;
    peer.joinNonce = message.nonce;
    sendToPeer(peer, { t: 'join-ack', nonce: message.nonce });
    peer.joinTimer = setTimeout(() => {
      if (networkState.peers.get(peer.id) !== peer || peer.admitted) return;
      sendToPeer(peer, { t: 'join-disconnect', nonce: peer.joinNonce, reason: 'ready-timeout' });
      peer.rejected = true;
      if (peer.kind === 'ws') { try { peer.sock.end(); } catch (e) {} }
    }, JOIN_ACK_TIMEOUT_MS);
    return;
  }
  if (message.t === 'join-ack' && networkState.role === 'client' && !peer.rejected) {
    if (!peer.admitted && message.nonce === peer.joinNonce) {
      sendToPeer(peer, { t: 'join-ready', nonce: message.nonce });
      admitPeer(peer);
    }
    return;
  }
  if (message.t === 'join-ready' && networkState.role === 'host' && !peer.rejected) {
    if (!peer.admitted && message.nonce === peer.joinNonce) admitPeer(peer);
    return;
  }
  if (message.t === 'join-disconnect') {
    peer.rejected = true;
    if (peer.joinTimer) clearTimeout(peer.joinTimer);
    if (networkState.role === 'client') {
      emitEvent('error', { where: 'join-ack', message: 'Host rejected the join handshake: ' + (message.reason || 'disconnected') });
      stopNetworking('join-rejected');
      return;
    }
    if (peer.kind === 'ws') { try { peer.sock.end(); } catch (e) {} }
    else if (peer.admitted) emitEvent('peer-disconnected', { id: peerId });
    return;
  }
  // Ignore every non-handshake packet until the one-shot join probe is acknowledged.
  if (!peer.admitted || peer.rejected) return;
  if (peer && message.t === 'hello') {
    const nextNick = message.nick || '?';
    const shouldEmitHello = !peer.helloSeen || peer.nick !== nextNick;
    peer.nick = nextNick;
    peer.helloSeen = true;
    if (shouldEmitHello) emitEvent('peer-hello', { id: peerId, nick: peer.nick });
    if (message.ver !== PROTO_VER) emitEvent('version-mismatch', { id: peerId, theirs: message.ver, ours: PROTO_VER });
	}
	emitMsg(peerId, message);
  // host relays player positions/hellos to the other clients (3+ player support)
	if (networkState.role === 'host' && (message.t === 'pos' || message.t === 'hello' || message.t === 'chat' || message.t === 'myproj' || message.t === 'snd') && networkState.peers.size > 1) {
		const relay = { t: 'relay', from: peerId, msg: message };
    for (const peer of networkState.peers.values()) if (peer.id !== peerId) sendToPeer(peer, relay);
  }
}

function sendToPeer(peer, obj) {
  const text = JSON.stringify(obj);
  try {
    if (peer.kind === 'ws') peer.sock.write(wsEncodeFrame(text, networkState.role === 'client'));
    else if (peer.kind === 'steam') {
      // ping, pong and wcack MUST bypass the reliable channel. Steam's reliable channel is ORDERED, so
      // neither can overtake a backlog of world packets: the HUD would report send queue depth instead of
      // RTT, and the mirror ack would feed the congestion controller state from tens of seconds ago,
      // which defeats the whole point of measuring. Losing one is harmless, ping goes out every 1 s and
      // wcack 10x per second, and both carry absolute state rather than a delta.
      const reliable = obj.t !== 'pos' && obj.t !== 'ping' && obj.t !== 'pong' && obj.t !== 'wcack';
      networkState.steam.networking.sendP2PPacket(BigInt(peer.steamId64), reliable ? networkState.steam.networking.SendType.Reliable : networkState.steam.networking.SendType.UnreliableNoDelay, Buffer.from(text, 'utf8'));
    }
  } catch (e) { log('send error to', peer.id, e.message); }
}

function netSend(obj, toId) {
  if (toId) { const peer = networkState.peers.get(toId); if (peer && peer.admitted) sendToPeer(peer, obj); return; }
  for (const peer of networkState.peers.values()) if (peer.admitted) sendToPeer(peer, obj);
}

function stopNetworking(reason) {
  if (networkState.wsServer) { try { networkState.wsServer.close(); } catch (e) {} networkState.wsServer = null; }
  if (networkState.wsClient) { try { networkState.wsClient.end(); } catch (e) {} networkState.wsClient = null; }
  if (networkState.lobby) { try { networkState.lobby.leave(); } catch (e) {} networkState.lobby = null; }
  // remove "Join Game" from Steama so it doesn't become outdated
  if (networkState.steam) { try { networkState.steam.localplayer.setRichPresence('connect', ''); } catch (e) {} }
  if (networkState.p2pPoll) { clearInterval(networkState.p2pPoll); networkState.p2pPoll = null; }
  for (const peer of networkState.peers.values()) if (peer.joinTimer) clearTimeout(peer.joinTimer);
  networkState.peers.clear();
  networkState.role = 'idle'; networkState.transport = null;
  if (reason !== 'restart') emitEvent('stopped', {});
}

function safeJson(o) { try { return JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? String(v) : v)); } catch (e) { return String(o); } }

// ============================================================================
// AUTO-UPDATE Z WARSZTATU: every time we start the game we compare the mod version in the folder
// Workshop (Steam updates it itself) with it installed. Nowsza → copy files, overlay
// patches bundle (idempotent, like install.ps1) and restart the game. Gracz makes install.bat
// only RAZ - each subsequent update comes automatically. Autor with newer local version than
// Never downgrade from the Workshop copy; compare numerically and update upward only.
// ============================================================================
const WORKSHOP_ITEM = '3784750764';
function parseVer(file) {
  try {
    const m = /const VER = "v?(\d+)\.(\d+)\.(\d+)/.exec(fs.readFileSync(file, 'utf8').slice(0, 4000));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch (e) { return null; }
}
function applyBundlePatches(bundlePath, patches) {
  let bundleContents = fs.readFileSync(bundlePath, 'utf8');
  let dirty = false, criticalFail = false, appliedCount = 0;
  for (const patchDefinition of patches.bundle || []) {
    let applied = false, already = false;
    for (const variant of patchDefinition.variants || []) {
      if (bundleContents.indexOf(variant.patched) >= 0) { already = true; break; }
      const anchorIndex = bundleContents.indexOf(variant.anchor);
      if (anchorIndex < 0) continue;
      if (bundleContents.indexOf(variant.anchor, anchorIndex + 1) >= 0) continue;
      bundleContents = bundleContents.slice(0, anchorIndex) + variant.patched + bundleContents.slice(anchorIndex + variant.anchor.length);
      dirty = true; applied = true; appliedCount++;
      break;
    }
    if (!applied && !already && patchDefinition.critical) criticalFail = true;
  }
  if (dirty) fs.writeFileSync(bundlePath, bundleContents);
  return { criticalFail, appliedN: appliedCount };
}
function applySimulationWorkerPatch(workerPath, bootstrapPath) {
  const MARK_A = '// --- SandustryMP deterministic simulation RNG ---';
  const MARK_B = '// --- /SandustryMP deterministic simulation RNG ---';
  let worker = fs.readFileSync(workerPath, 'utf8');
  const start = worker.indexOf(MARK_A);
  if (start >= 0) {
    const end = worker.indexOf(MARK_B, start);
    if (end < 0) throw new Error('simulation-worker.js has an incomplete SandustryMP RNG block');
    worker = worker.slice(0, start) + worker.slice(end + MARK_B.length).replace(/^\s+/, '');
  }
  const bootstrap = fs.readFileSync(bootstrapPath, 'utf8').trimEnd();
  fs.writeFileSync(workerPath, bootstrap + '\n' + worker);
}
function autoUpdateFromWorkshop() {
  try {
    // Windows: steamapps/common/Sandustry/resources/app (4 levels up)
    // macOS: steamapps/common/Sandustry/Sandustry.app/Contents/Resources/app (6 levels)
    // → we look for the "steamapps" directory UP instead of counting levels.
    let steamapps = __dirname;
    for (let i = 0; i < 8 && path.basename(steamapps).toLowerCase() !== 'steamapps'; i++) steamapps = path.dirname(steamapps);
    if (path.basename(steamapps).toLowerCase() !== 'steamapps') return;
    const ws = path.join(steamapps, 'workshop', 'content', '2764460', WORKSHOP_ITEM);
    const wsMod = path.join(ws, 'src', 'sandustrymp.js');
    const localMod = path.join(appDir, 'dist', 'js', 'sandustrymp.js');
    if (!fs.existsSync(wsMod) || !fs.existsSync(localMod)) return;
    const wv = parseVer(wsMod), lv = parseVer(localMod);
    if (!wv || !lv) return;
    const cmp = (wv[0] - lv[0]) || (wv[1] - lv[1]) || (wv[2] - lv[2]);
    if (cmp <= 0) return; // Local version is at least the Workshop version, so no update is needed.
    log("AUTO-UPDATE: Workshop has " + wv.join('.') + ', local version is ' + lv.join('.') + ' - updating...');
    fs.copyFileSync(wsMod, localMod);
    for (const rendererModule of ['localisation.js', 'state.js', 'network.js', 'menu.js']) {
      try { fs.copyFileSync(path.join(ws, 'src', rendererModule), path.join(appDir, 'dist', 'js', rendererModule)); } catch (e) {}
    }
    try {
      const indexPath = path.join(appDir, 'dist', 'index.html');
      let indexContents = fs.readFileSync(indexPath, 'utf8');
      for (const rendererScript of ['localisation', 'state', 'network', 'menu', 'sandustrymp']) {
        indexContents = indexContents.replace(new RegExp('\\s*<script src="js/' + rendererScript + '\\.js"><\\/script>', 'g'), '');
      }
      const rendererTags = ['localisation', 'state', 'network', 'menu', 'sandustrymp']
        .map((rendererScript) => '    <script src="js/' + rendererScript + '.js"></script>')
        .join('\n') + '\n';
      indexContents = indexContents.replace('<script type="module" src="js/bundle.js"></script>', rendererTags + '    <script type="module" src="js/bundle.js"></script>');
      fs.writeFileSync(indexPath, indexContents);
    } catch (e) { log('AUTO-UPDATE: renderer module tags:', e.message); }
    try { fs.copyFileSync(path.join(ws, 'src', 'smp-main.js'), path.join(appDir, 'smp-main.js')); } catch (e) {}
    try {
      const pl = path.join(appDir, 'preload.js');
      let ps = fs.readFileSync(pl, 'utf8');
      if (ps.indexOf('sandustrympNet') < 0) { ps += '\n' + fs.readFileSync(path.join(ws, 'src', 'smp-preload-append.js'), 'utf8'); fs.writeFileSync(pl, ps); }
    } catch (e) {}
    const patches = JSON.parse(fs.readFileSync(path.join(ws, 'src', 'patches.json'), 'utf8'));
    const res = applyBundlePatches(path.join(appDir, 'dist', 'js', 'bundle.js'), patches);
    applySimulationWorkerPatch(path.join(appDir, 'dist', 'js', 'simulation-worker.js'), path.join(ws, 'src', 'sim-worker-bootstrap.js'));
    log('AUTO-UPDATE: files copied, bundle patches: +' + res.appliedN + ', simulation worker RNG patched' + (res.criticalFail ? ' (WARNING: critical anchor does not match; game build is newer than the mod!)' : ''));
    // restart so that the new files (bundle/renderer/main) actually load
    const { app } = require('electron');
    log('AUTO-UPDATE: restart the game with a new version of the mod' + wv.join('.'));
    app.relaunch();
    app.exit(0);
  } catch (e) { log('autoUpdate error:', e.message); }
}

// Odcisk build GRY (bundle size + sha1 of the first 256KB): Steam can serve to different people
// Different builds may share a version number but use different enums or anchors. Compare this fingerprint during `mver` exchange.
let _gameFpCache;
function gameFingerprint() {
  if (_gameFpCache !== undefined) return _gameFpCache;
  try {
    const bundlePath = path.join(__dirname, 'dist', 'js', 'bundle.js');
    const bundleStats = fs.statSync(bundlePath);
    const fileDescriptor = fs.openSync(bundlePath, 'r');
    const fingerprintBytes = Buffer.alloc(Math.min(262144, bundleStats.size));
    fs.readSync(fileDescriptor, fingerprintBytes, 0, fingerprintBytes.length, 0);
    fs.closeSync(fileDescriptor);
    _gameFpCache = bundleStats.size + '-' + crypto.createHash('sha1').update(fingerprintBytes).digest('hex').slice(0, 10);
  } catch (e) { _gameFpCache = null; }
  return _gameFpCache;
}

// ---------------------------------------------------------------------------
// Init + IPC
// ---------------------------------------------------------------------------
function init(opts) {
  networkState.getMainWindow = opts.getMainWindow;
  autoUpdateFromWorkshop(); // nowsza wersja w folderze Workshop → auto-instalacja + restart gry
  // Diagnostyka: show start arguments (you can see if Steam specified +connect_lobby when connecting)
  try { log('start argv:', JSON.stringify(process.argv.slice(1))); } catch (e) {}
  // Steam initializes asynchronously after the app starts - keep trying until you succeed
  let tries = 0;
  const grabSteam = setInterval(() => {
    tries++;
    try {
      const c = require('./steam').getSteamClient();
      if (c) {
        clearInterval(grabSteam);
        networkState.steam = c;
        networkState.myNick = c.localplayer.getName();
        networkState.myId = String(c.localplayer.getSteamId().steamId64);
        registerSteamCallbacks();
        log('Steam OK — nick:', networkState.myNick, 'id:', networkState.myId);
        // Accepting an invite while the game is closed launches it with `+connect_lobby`.
        if (networkState._pendingJoin) { const id = networkState._pendingJoin; networkState._pendingJoin = null; setTimeout(() => joinSteamLobby(String(id)).catch(() => {}), 500); }
        else setTimeout(() => tryJoinFromArgv(process.argv, 'cold-launch'), 500);
        return;
      }
    } catch (e) { /* Steam is not ready yet. */ }
    if (tries >= 30) { clearInterval(grabSteam); log('Steam unavailable after 60s - WS transport only'); }
  }, 2000);

  const { ipcMain, app } = require('electron');
  // Handle an invite accepted while the game is running and the user is outside the overlay.
  // Steam fires up the second instance → single-instance kills it and we get its argv here.
  try { app.on('second-instance', (event, argv) => { log('second-instance argv:', JSON.stringify(argv)); tryJoinFromArgv(argv, 'second-instance'); }); } catch (e) {}
  ipcMain.handle('smp:host-steam', async () => { try { return { ok: true, ...(await hostSteam()) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('smp:join-steam', async (ev, lobbyId) => { try { return { ok: true, ...(await joinSteamLobby(lobbyId)) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('smp:invite', async () => { try { if (!networkState.lobby) return { ok: false, error: 'no lobby' }; networkState.lobby.openInviteDialog(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('smp:host-ws', async (ev, port) => { try { startWsServer(port || 27777); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('smp:join-ws', async (ev, host, port) => { try { joinWs(host, port || 27777); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('smp:stop', async () => { stopNetworking(); return { ok: true }; });
  ipcMain.on('smp:send', (ev, payload, toId) => netSend(payload, toId));
  ipcMain.handle('smp:status', async () => ({
    role: networkState.role, transport: networkState.transport, myNick: networkState.myNick, myId: networkState.myId,
    lobbyId: networkState.lobby ? String(networkState.lobby.id) : null,
    peers: [...networkState.peers.values()].filter((p) => p.admitted).map((p) => ({ id: p.id, kind: p.kind, nick: p.nick })),
    gameFp: gameFingerprint(),
  }));
  // Self-test mode: `--smp-autotest=host` or `--smp-autotest=join` tests two instances without UI interaction.
  const autotest = process.argv.find((a) => a.startsWith('--smp-autotest='));
  if (autotest) {
    const mode = autotest.split('=')[1];
    log('AUTOTEST:', mode, '(start za 10s)');
    setTimeout(() => {
      try {
        if (mode === 'host') startWsServer(27777);
        else if (mode === 'join') joinWs('127.0.0.1', 27777);
      } catch (e) { log('autotest error:', e.message); }
    }, 10000);
  }

  log('init OK (proto v' + PROTO_VER + ')');
}

module.exports = { init };
