import { EventEmitter } from 'node:events';
import { createServer, Server } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { AppState, Clip, Command, Device, DiscoveredRoom, Room, Settings } from '../shared/types';
import { checkProof, fingerprint, makeCertificate, normalizeCode, prove, roomCode, safetyCode } from './crypto';
import { Store } from './store';
import { ClipboardPort, ClipboardSync, MAX_CLIP_BYTES } from './clipboard';
import { addresses, DiscoveryPort, LanDiscovery } from './discovery';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_NOTE = 2 * 1024 * 1024;
interface Peer {
  ws: WebSocket; nonce: string; authenticated: boolean; device?: Device;
  timer: ReturnType<typeof setTimeout>; alive: boolean; window: number; frames: number;
}
interface ServiceOptions { discovery?: DiscoveryPort; preferredPort?: number; reconnectMs?: number }
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw new Error('이름은 1~60자로 입력하세요.');
  return value.trim();
}
function decode(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > MAX_FRAME * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('잘못된 메모 데이터입니다.');
  return new Uint8Array(Buffer.from(value, 'base64'));
}
export function parseAddress(address: string): { host: string; port: number } {
  const parts = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(address.trim());
  if (!parts || parts[1].split('.').some(s => +s > 255) || +parts[2] < 1 || +parts[2] > 65535) throw new Error('연결 주소는 192.168.0.10:48765 형식으로 입력하세요.');
  const octets = parts[1].split('.').map(Number);
  if (!(octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254))) throw new Error('같은 LAN의 사설 IPv4 주소를 입력하세요.');
  return { host: parts[1], port: +parts[2] };
}

export class AppService extends EventEmitter {
  private doc = new Y.Doc();
  private discovery: DiscoveryPort;
  private discovered: DiscoveredRoom[] = [];
  private connection: AppState['connection'] = 'idle';
  private error: string | null = null;
  private safety: string | null = null;
  private server?: Server;
  private wss?: WebSocketServer;
  private peers = new Map<WebSocket, Peer>();
  private client?: WebSocket;
  private pendingTarget?: { code: string; host: string; port: number; fingerprint?: string; id?: string };
  private retry?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopping = false;
  private closed = false;
  private clipboard: ClipboardSync;
  private revision = 0;
  constructor(readonly store: Store, clipboardPort: ClipboardPort, private options: ServiceOptions = {}) {
    super();
    this.discovery = options.discovery ?? new LanDiscovery();
    if (store.data.document) Y.applyUpdate(this.doc, decode(store.data.document));
    this.bindDocument();
    this.clipboard = new ClipboardSync(clipboardPort, () => store.data.identity, clip => this.publishClip(clip));
    store.data.devices.forEach(d => { d.online = false; });
    if (store.recovered) this.error = '마지막 정상 백업에서 데이터를 복구했습니다.';
  }
  async start(): Promise<void> {
    this.discovery.start(rooms => {
      this.discovered = rooms.filter(r => r.id !== (this.store.data.room?.role === 'host' ? this.store.data.room.id : ''));
      this.notify();
    }, error => { this.error = error; this.notify(); });
    this.pollTimer = setInterval(() => {
      try { this.clipboard.poll(this.store.data.settings.autoClipboard && ['hosting', 'connected'].includes(this.connection)); }
      catch (e) { this.fail(e); }
    }, 250);
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (!peer.alive) { peer.ws.terminate(); continue; }
        peer.alive = false; peer.ws.ping();
      }
    }, 5000);
    const room = this.store.data.room;
    if (room?.role === 'host') await this.host();
    else if (room) this.connect({ code: room.code, host: room.host, port: room.port, id: room.id, fingerprint: room.fingerprint });
  }
  state(): AppState {
    const identity = this.store.data.identity;
    const devices = this.store.data.devices.map(d => ({ ...d }));
    const own: Device = { ...identity, publicKey: identity.publicKey, trusted: true, online: true, lastSeen: Date.now(), isHost: this.store.data.room?.hostId === identity.id };
    // Never expose the private signing key to the renderer.
    const ownPublic: Device = { id: own.id, name: own.name, os: own.os, publicKey: own.publicKey, trusted: own.trusted, online: own.online, lastSeen: own.lastSeen, isHost: own.isHost };
    const index = devices.findIndex(d => d.id === identity.id);
    if (index >= 0) devices[index] = ownPublic; else devices.unshift(ownPublic);
    return {
      device: { id: identity.id, name: identity.name, os: identity.os }, settings: { ...this.store.data.settings },
      room: this.store.data.room ? { ...this.store.data.room } : null, devices,
      clips: this.store.data.clips.map(c => ({ ...c })),
      requests: [...this.peers.values()].filter(p => p.device && !p.authenticated).map(p => ({ id: p.device!.id, name: p.device!.name, os: p.device!.os, safetyCode: safetyCode(p.nonce, p.device!.publicKey, this.store.data.room!.fingerprint) })),
      discovered: this.discovered.map(r => ({ ...r })), connection: this.connection,
      error: this.error, safetyCode: this.safety, addresses: addresses(), storageProtected: this.store.codec.protected,
    };
  }
  document(): Uint8Array { return Y.encodeStateAsUpdate(this.doc); }
  documentRevision(): number { return this.revision; }
  text(): string { return this.doc.getText('note').toString(); }
  applyRendererUpdate(data: number[]): void {
    if (!Array.isArray(data) || data.length > MAX_FRAME || data.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('잘못된 편집 데이터입니다.');
    this.applyDocument(new Uint8Array(data), 'renderer');
  }
  private applyDocument(data: Uint8Array, origin: unknown): void {
    // Check the result before modifying the live document; a hostile peer cannot corrupt persisted data.
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, this.document()); Y.applyUpdate(candidate, data);
      if (Buffer.byteLength(candidate.getText('note').toString(), 'utf8') > MAX_NOTE || Y.encodeStateAsUpdate(candidate).length > MAX_FRAME) throw new Error('메모의 최대 크기는 2MB입니다.');
      Y.applyUpdate(this.doc, data, origin);
    } finally { candidate.destroy(); }
  }
  private bindDocument(): void {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.emit('document', [...update]);
      const message = { type: 'update', data: Buffer.from(update).toString('base64') };
      if (this.store.data.room?.role === 'host') this.broadcast(message, origin instanceof WebSocket ? origin : undefined);
      else if (origin !== 'network' && this.connection === 'connected') this.send(this.client, message);
      this.scheduleSave();
    });
  }
  private resetDocument(saved = ''): void {
    this.revision++;
    this.doc.destroy(); this.doc = new Y.Doc();
    if (saved) Y.applyUpdate(this.doc, decode(saved));
    this.bindDocument();
    this.emit('reset');
  }
  async command(command: Command): Promise<void> {
    this.error = null;
    switch (command.type) {
      case 'create': {
        const roomName = name(command.name); await this.stopNetwork();
        this.store.data.certificate ??= makeCertificate();
        this.store.data.room = { id: randomUUID(), name: roomName, code: roomCode(), hostId: this.store.data.identity.id, host: '', port: this.options.preferredPort ?? 48765, fingerprint: this.store.data.certificate.fingerprint, role: 'host' };
        this.store.data.devices = []; this.store.data.clips = []; this.resetDocument();
        await this.host(); this.flush(); break;
      }
      case 'join': {
        const code = normalizeCode(command.code);
        if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error('방 번호는 A7K2-91처럼 6자리로 입력하세요.');
        const matches = this.discovered.filter(r => normalizeCode(r.code) === code);
        if (!command.address && matches.length > 1) throw new Error('같은 번호의 방이 여러 개입니다. 방장에게 IP:포트 주소를 받아 입력하세요.');
        const found = matches[0];
        const target = command.address ? { ...parseAddress(command.address), code: command.code } : found;
        if (!target) throw new Error('방을 찾지 못했습니다. 방장의 IP:포트를 입력해 수동 연결하세요.');
        await this.stopNetwork();
        const saved = this.store.data.room;
        const trustedTarget = saved?.role === 'member' && normalizeCode(saved.code) === code;
        if (command.fingerprint && !/^[a-f0-9]{64}$/.test(command.fingerprint)) throw new Error('잘못된 QR 인증서 정보입니다.');
        this.connect({ ...target, code: command.code,
          ...(command.fingerprint ? { fingerprint: command.fingerprint, id: command.roomId } : {}),
          ...(trustedTarget ? { fingerprint: saved.fingerprint, id: saved.id } : {}) }); break;
      }
      case 'approve': {
        this.requireHost();
        const peer = [...this.peers.values()].find(p => p.device?.id === command.id && !p.authenticated);
        if (!peer) throw new Error('참가 요청이 만료됐습니다.');
        if (command.accept) this.authorize(peer);
        else { this.send(peer.ws, { type: 'rejected', reason: '방장이 참가 요청을 거절했습니다.' }); peer.ws.close(4003); }
        break;
      }
      case 'removeDevice': {
        this.requireHost();
        if (command.id === this.store.data.identity.id) throw new Error('방장 자신은 제거할 수 없습니다.');
        this.store.data.devices = this.store.data.devices.filter(d => d.id !== command.id);
        for (const peer of this.peers.values()) if (peer.device?.id === command.id) {
          peer.authenticated = false;
          this.send(peer.ws, { type: 'revoked', reason: '방장이 신뢰를 해제했습니다. 다시 참가하려면 승인이 필요합니다.' }); peer.ws.close(4003);
        }
        this.flush(); this.roster(); break;
      }
      case 'rename': {
        this.store.data.identity.name = name(command.name);
        if (this.connection === 'connected') this.send(this.client, { type: 'rename', name: this.store.data.identity.name });
        this.flush(); if (this.connection === 'hosting') this.roster(); break;
      }
      case 'settings': this.setSettings(command.settings); break;
      case 'shareClip':
        if (!['hosting', 'connected'].includes(this.connection)) throw new Error('연결된 방에서만 클립보드를 보낼 수 있습니다.');
        this.clipboard.share(command.text); break;
      case 'copyClip': {
        const clip = this.store.data.clips.find(c => c.id === command.id);
        if (clip) this.clipboard.copy(clip.text); break;
      }
      case 'copyText':
        if (typeof command.text !== 'string' || Buffer.byteLength(command.text) > MAX_CLIP_BYTES) throw new Error('복사할 텍스트가 너무 큽니다.');
        this.clipboard.copy(command.text); break;
      case 'deleteClip': this.store.data.clips = this.store.data.clips.filter(c => c.id !== command.id); this.flush(); break;
      case 'clearClips': this.store.data.clips = []; this.flush(); break;
      case 'pinClip': {
        const clip = this.store.data.clips.find(c => c.id === command.id);
        if (clip) {
          if (!clip.pinned && this.store.data.clips.filter(c => c.pinned).length >= 30) throw new Error('최대 30개까지 고정할 수 있습니다.');
          clip.pinned = !clip.pinned; this.flush();
        } break;
      }
      case 'leave':
        await this.stopNetwork(); this.store.data.room = null; this.store.data.devices = []; this.store.data.clips = [];
        this.connection = 'idle'; this.flush(); break;
      case 'reconnect': {
        const room = this.store.data.room;
        if (!room) throw new Error('참가할 방이 없습니다.');
        await this.stopNetwork();
        if (room.role === 'host') await this.host();
        else this.connect({ ...room, ...(this.discovered.find(r => r.id === room.id) ?? {}), fingerprint: room.fingerprint });
        break;
      }
      case 'exportNote': break; // The desktop adapter opens the native save dialog.
      default: throw new Error('지원하지 않는 요청입니다.');
    }
    this.notify();
  }
  private setSettings(patch: Partial<Settings>): void {
    const settings = this.store.data.settings;
    if (patch.theme !== undefined) { if (!['light', 'dark'].includes(patch.theme)) throw new Error('잘못된 테마입니다.'); settings.theme = patch.theme; }
    if (patch.fontSize !== undefined) { if (!Number.isInteger(patch.fontSize) || patch.fontSize < 12 || patch.fontSize > 32) throw new Error('글자 크기는 12~32입니다.'); settings.fontSize = patch.fontSize; }
    if (patch.fontFamily !== undefined) { if (!['Malgun Gothic', 'Segoe UI', 'Consolas', 'Cascadia Code', 'Arial'].includes(patch.fontFamily)) throw new Error('지원하지 않는 글꼴입니다.'); settings.fontFamily = patch.fontFamily; }
    for (const key of ['autoClipboard', 'autoStart'] as const) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw new Error('잘못된 설정입니다.'); settings[key] = patch[key]; }
    this.flush();
  }
  private async host(): Promise<void> {
    const room = this.store.data.room!;
    this.store.data.certificate ??= makeCertificate();
    const certificate = this.store.data.certificate;
    room.fingerprint = certificate.fingerprint;
    const server = createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.2' }, (_req, res) => { res.writeHead(404); res.end(); });
    this.server = server;
    this.wss = new WebSocketServer({ server, maxPayload: MAX_FRAME, perMessageDeflate: false });
    this.wss.on('connection', ws => this.accept(ws));
    this.wss.on('error', e => this.fail(e));
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); }
        else reject(e);
      };
      server.once('error', onError);
      server.listen(room.port, '0.0.0.0', () => { server.removeListener('error', onError); resolve(); });
    });
    server.on('error', e => this.fail(e));
    room.port = (server.address() as { port: number }).port; room.host = addresses()[0] ?? '127.0.0.1';
    this.connection = 'hosting'; this.stopping = false;
    this.discovery.publish(room); this.flush(); this.notify();
  }
  private accept(ws: WebSocket): void {
    if (this.peers.size >= 24) { ws.close(4008, 'Room capacity'); return; }
    const peer: Peer = { ws, nonce: randomBytes(32).toString('hex'), authenticated: false, timer: setTimeout(() => ws.close(4003, 'Authentication timeout'), 10000), alive: true, window: Date.now(), frames: 0 };
    this.peers.set(ws, peer);
    const room = this.store.data.room!;
    this.send(ws, { type: 'challenge', nonce: peer.nonce, room: { id: room.id, name: room.name, code: room.code, hostId: room.hostId, port: room.port }, hostPublicKey: this.store.data.identity.publicKey });
    ws.on('pong', () => { peer.alive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        if (Date.now() - peer.window > 1000) { peer.window = Date.now(); peer.frames = 0; }
        if (++peer.frames > 500) throw new Error('Too many messages');
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'hello' && !peer.device) {
          if (normalizeCode(msg.code ?? '') !== normalizeCode(room.code)) throw new Error('잘못된 방 번호입니다.');
          const d = msg.device;
          if (!d || !/^[a-f0-9]{32}$/.test(d.id) || d.id === this.store.data.identity.id || typeof d.publicKey !== 'string' || d.publicKey.length > 1000 || !checkProof(d.publicKey, d.id, peer.nonce, room.id, msg.proof)) throw new Error('기기 인증에 실패했습니다.');
          if ([...this.peers.values()].some(p => p !== peer && p.device?.id === d.id && !p.authenticated)) throw new Error('중복 참가 요청입니다.');
          peer.device = { id: d.id, name: name(d.name), os: String(d.os).slice(0, 40), publicKey: d.publicKey, online: true, lastSeen: Date.now(), isHost: false, trusted: false };
          clearTimeout(peer.timer);
          peer.timer = setTimeout(() => { this.send(ws, { type: 'rejected', reason: '참가 승인을 기다리는 시간이 만료됐습니다.' }); ws.close(4003); }, 120000);
          const trusted = this.store.data.devices.find(t => t.id === d.id && t.publicKey === d.publicKey && t.trusted);
          if (trusted) this.authorize(peer);
          else { this.send(ws, { type: 'pending', safetyCode: safetyCode(peer.nonce, d.publicKey, room.fingerprint) }); this.notify(); }
          return;
        }
        if (!peer.authenticated || !peer.device) throw new Error('승인되지 않은 기기입니다.');
        if (msg.type === 'update') this.applyDocument(decode(msg.data), ws);
        else if (msg.type === 'clipboard') {
          const clip = this.validateClip(msg.clip, peer.device);
          if (this.receiveClip(clip)) this.broadcast({ type: 'clipboard', clip }, ws);
        } else if (msg.type === 'rename') {
          peer.device.name = name(msg.name); peer.device.lastSeen = Date.now();
          this.flush(); this.roster();
        } else throw new Error('잘못된 메시지입니다.');
      } catch (e) {
        this.send(ws, { type: 'rejected', reason: e instanceof Error ? e.message : '잘못된 요청입니다.' }); ws.close(4003);
      }
    });
    ws.on('close', () => {
      clearTimeout(peer.timer);
      if (!this.peers.has(ws)) return;
      this.peers.delete(ws);
      if (peer.device && ![...this.peers.values()].some(p => p.authenticated && p.device?.id === peer.device!.id)) {
        const d = this.store.data.devices.find(d => d.id === peer.device!.id);
        if (d) { d.online = false; d.lastSeen = Date.now(); this.flush(); }
      }
      this.roster(); this.notify();
    });
  }
  private authorize(peer: Peer): void {
    const device = peer.device!;
    for (const old of this.peers.values()) if (old !== peer && old.device?.id === device.id) old.ws.close(4001, 'New session');
    device.trusted = true; device.lastSeen = Date.now(); peer.authenticated = true; clearTimeout(peer.timer);
    this.store.data.devices = [...this.store.data.devices.filter(d => d.id !== device.id), device];
    this.flush();
    this.send(peer.ws, { type: 'ready', data: Buffer.from(this.document()).toString('base64'), devices: this.state().devices });
    this.roster(); this.notify();
  }
  private connect(target: NonNullable<AppService['pendingTarget']>): void {
    this.stopping = false; this.pendingTarget = target; this.connection = 'connecting'; this.safety = null;
    const ws = new WebSocket(`wss://${target.host}:${target.port}`, { rejectUnauthorized: false, maxPayload: MAX_FRAME, handshakeTimeout: 8000, perMessageDeflate: false });
    this.client = ws;
    let fp = '', proposedRoom: Room | undefined, hostKey = '', alive = true;
    const deadline = setTimeout(() => { this.error = '방장의 승인이 없거나 연결 시간이 만료됐습니다.'; ws.close(4003); }, 135000);
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping(); } }, 5000);
    ws.on('pong', () => { alive = true; });
    ws.on('open', () => {
      const cert = (ws as unknown as { _socket: TLSSocket })._socket.getPeerCertificate();
      try {
        fp = fingerprint(cert.raw);
        if (target.fingerprint && fp !== target.fingerprint) throw new Error('방장 인증서가 변경됐습니다. 연결을 차단했습니다. 방장에게 확인한 뒤 방을 나가 새로 참가하세요.');
      } catch (e) { this.fail(e); ws.close(4003); this.connection = 'rejected'; this.notify(); }
    });
    ws.on('message', raw => {
      try {
        if (!fp || ws.readyState !== WebSocket.OPEN) return;
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'challenge') {
          if (proposedRoom || typeof msg.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(msg.nonce) || normalizeCode(msg.room?.code ?? '') !== normalizeCode(target.code) || (target.id && target.id !== msg.room.id) || typeof msg.hostPublicKey !== 'string') throw new Error('방 정보가 일치하지 않습니다.');
          proposedRoom = { id: msg.room.id, name: name(msg.room.name), code: msg.room.code, hostId: msg.room.hostId, host: target.host, port: target.port, fingerprint: fp, role: 'member' };
          hostKey = msg.hostPublicKey;
          this.safety = safetyCode(msg.nonce, this.store.data.identity.publicKey, fp);
          this.send(ws, { type: 'hello', code: target.code, device: { ...this.state().device, publicKey: this.store.data.identity.publicKey }, proof: prove(this.store.data.identity, msg.nonce, proposedRoom.id) });
          this.connection = 'approval'; this.notify();
        } else if (msg.type === 'pending') { this.connection = 'approval'; this.notify(); }
        else if (msg.type === 'ready' && proposedRoom) {
          clearTimeout(deadline);
          const update = decode(msg.data), sameRoom = this.store.data.room?.id === proposedRoom.id;
          if (!sameRoom) { this.resetDocument(); this.store.data.clips = []; }
          this.store.data.room = proposedRoom;
          this.store.data.devices = this.validateRoster(msg.devices, proposedRoom, hostKey);
          this.applyDocument(update, 'network'); this.connection = 'connected'; this.error = null;
          this.send(ws, { type: 'update', data: Buffer.from(this.document()).toString('base64') });
          this.flush(); this.notify();
        } else if (msg.type === 'rejected' || msg.type === 'revoked') {
          this.connection = 'rejected'; this.error = String(msg.reason).slice(0, 200); this.notify(); ws.close(4003);
        } else if (this.connection === 'connected') {
          if (msg.type === 'update') this.applyDocument(decode(msg.data), 'network');
          else if (msg.type === 'devices') {
            this.store.data.devices = this.validateRoster(msg.devices, this.store.data.room!, hostKey); this.flush(); this.notify();
          } else if (msg.type === 'clipboard') {
            const device = this.store.data.devices.find(d => d.id === msg.clip?.originId);
            if (device) this.receiveClip(this.validateClip(msg.clip, device));
          } else throw new Error('잘못된 메시지입니다.');
        } else throw new Error('승인 전 데이터를 받았습니다.');
      } catch (e) { this.fail(e); this.connection = 'rejected'; ws.close(4003); this.notify(); }
    });
    ws.on('error', () => { if (this.client === ws && this.connection !== 'rejected') { this.error = '방장과 연결할 수 없습니다. LAN, 방화벽, IP:포트를 확인하세요.'; this.notify(); } });
    ws.on('close', () => {
      clearTimeout(deadline); clearInterval(heartbeat);
      if (this.client !== ws) return;
      this.client = undefined;
      this.store.data.devices.forEach(d => { d.online = d.id === this.store.data.identity.id; });
      if (!this.stopping && this.connection !== 'rejected') {
        this.connection = 'offline';
        if (this.store.data.room?.role === 'member') this.retry = setTimeout(() => {
          const room = this.store.data.room!;
          const discovered = this.discovered.find(r => r.id === room.id);
          this.connect({ ...room, ...(discovered ? { host: discovered.host, port: discovered.port } : {}), fingerprint: room.fingerprint });
        }, this.options.reconnectMs ?? 3000);
      }
      this.notify();
    });
    this.notify();
  }
  private validateRoster(value: unknown, room: Room, hostKey: string): Device[] {
    if (!Array.isArray(value) || value.length > 100) throw new Error('잘못된 기기 목록입니다.');
    return value.map(d => {
      if (!d || typeof d.id !== 'string' || typeof d.publicKey !== 'string' || (d.id === room.hostId && d.publicKey !== hostKey)) throw new Error('기기 정보가 일치하지 않습니다.');
      return { id: d.id.slice(0, 64), name: name(d.name), os: String(d.os).slice(0, 40), publicKey: d.publicKey.slice(0, 1000), trusted: !!d.trusted, online: !!d.online, lastSeen: Number(d.lastSeen) || Date.now(), isHost: d.id === room.hostId };
    });
  }
  private validateClip(value: unknown, device: Device): Clip {
    const c = value as Clip;
    if (!c || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/.test(c.id) || typeof c.text !== 'string' || !c.text || Buffer.byteLength(c.text) > MAX_CLIP_BYTES) throw new Error('잘못된 클립보드입니다.');
    return { id: c.id, originId: device.id, originName: device.name, text: c.text, createdAt: Date.now(), pinned: false };
  }
  private publishClip(clip: Clip): void {
    this.addClip(clip);
    if (this.connection === 'hosting') this.broadcast({ type: 'clipboard', clip });
    else if (this.connection === 'connected') this.send(this.client, { type: 'clipboard', clip });
  }
  private receiveClip(clip: Clip): boolean {
    if (this.store.data.clips.some(c => c.id === clip.id)) return false;
    if (!this.clipboard.receive(clip, this.store.data.settings.autoClipboard)) return false;
    this.addClip(clip); return true;
  }
  private addClip(clip: Clip): void {
    this.store.data.clips.unshift(clip);
    const pins = this.store.data.clips.filter(c => c.pinned);
    this.store.data.clips = [...pins, ...this.store.data.clips.filter(c => !c.pinned).slice(0, 100 - pins.length)];
    this.flush(); this.notify();
  }
  private requireHost(): void { if (this.store.data.room?.role !== 'host') throw new Error('방장만 관리할 수 있습니다.'); }
  private roster(): void { if (this.store.data.room?.role === 'host') this.broadcast({ type: 'devices', devices: this.state().devices }); }
  private broadcast(message: unknown, except?: WebSocket): void {
    for (const peer of this.peers.values()) if (peer.authenticated && peer.ws !== except) this.send(peer.ws, message);
  }
  private send(ws: WebSocket | undefined, message: unknown): void {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_FRAME * 2) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  }
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; try { this.flush(); } catch (e) { this.fail(e); } }, 120);
  }
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.store.data.document = Buffer.from(this.document()).toString('base64'); this.store.save();
  }
  private notify(): void { this.emit('state', this.state()); }
  private fail(e: unknown): void { this.error = e instanceof Error ? e.message : String(e); this.notify(); }
  private async stopNetwork(): Promise<void> {
    this.discovery.unpublish?.();
    this.stopping = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    const ws = this.client; this.client = undefined; ws?.terminate();
    for (const peer of this.peers.values()) { clearTimeout(peer.timer); peer.ws.terminate(); }
    this.peers.clear();
    this.wss?.close(); this.wss = undefined;
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.store.data.devices.forEach(d => { d.online = false; });
    this.safety = null; this.connection = 'idle';
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.discovery.close(); await this.stopNetwork(); this.flush(); this.doc.destroy(); this.removeAllListeners();
  }
}
