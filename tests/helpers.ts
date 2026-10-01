import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { AppService } from '../src/core/service';
import { Store } from '../src/core/store';
import type { ClipboardPort } from '../src/core/clipboard';
import type { DiscoveryPort } from '../src/core/discovery';

export class MemoryClipboard implements ClipboardPort {
  text = ''; writes = 0;
  readText() { return this.text; }
  writeText(text: string) { this.text = text; this.writes++; }
}
export const noDiscovery: DiscoveryPort = { start() {}, publish() {}, close() {} };
export function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'localsync-test-'));
  const store = new Store(path), clipboard = new MemoryClipboard();
  const service = new AppService(store, clipboard, { discovery: noDiscovery, preferredPort: 0, reconnectMs: 150 });
  return { path, store, clipboard, service, async cleanup() { await service.close(); rmSync(path, { recursive: true, force: true }); } };
}
export async function until(predicate: () => boolean, label = 'condition', timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
export async function joinRoom(host: AppService, client: AppService) {
  const room = host.state().room!;
  await client.command({ type: 'join', code: room.code, address: `127.0.0.1:${room.port}`, fingerprint: room.fingerprint, roomId: room.id });
  await until(() => host.state().requests.some(r => r.id === client.state().device.id), 'join request');
  await host.command({ type: 'approve', id: client.state().device.id, accept: true });
  await until(() => client.state().connection === 'connected', 'approval');
}
export function editor(service: AppService) {
  let doc = new Y.Doc(); Y.applyUpdate(doc, service.document(), 'network');
  function bind() { doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'network') service.applyRendererUpdate([...update]); }); }
  bind();
  const update = (data: number[]) => Y.applyUpdate(doc, new Uint8Array(data), 'network');
  const reset = () => { doc.destroy(); doc = new Y.Doc(); Y.applyUpdate(doc, service.document(), 'network'); bind(); };
  service.on('document', update); service.on('reset', reset);
  return { get text() { return doc.getText('note'); }, close() { service.off('document', update); service.off('reset', reset); doc.destroy(); } };
}
