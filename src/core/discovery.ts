import { Bonjour, Browser, Service } from 'bonjour-service';
import { networkInterfaces } from 'node:os';
import { DiscoveredRoom, Room } from '../shared/types';

export function addresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address),
  );
}
export interface DiscoveryPort {
  start(callback: (rooms: DiscoveredRoom[]) => void, onError: (error: string) => void): void;
  publish(room: Room): void;
  unpublish?(): void;
  close(): void;
}
export class LanDiscovery implements DiscoveryPort {
  private bonjour?: Bonjour;
  private browser?: Browser;
  private service?: Service;
  private rooms = new Map<string, DiscoveredRoom>();
  start(callback: (rooms: DiscoveredRoom[]) => void, onError: (error: string) => void): void {
    try {
      this.bonjour = new Bonjour({}, (error: Error) =>
        onError(
          `자동 검색을 시작하지 못했습니다. IP:포트로 연결할 수 있습니다. (${error.message})`,
        ),
      );
      this.browser = this.bonjour.find({ type: 'localsync' });
      this.browser.on('up', (service) => {
        const txt = service.txt as Record<string, string>;
        const host = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (!host || !txt.id || !txt.code || !/^[a-f0-9]{64}$/.test(txt.fp ?? '')) return;
        this.rooms.set(service.fqdn, {
          id: txt.id,
          name: txt.name?.slice(0, 60) || 'LAN 메모방',
          code: txt.code,
          fingerprint: txt.fp,
          host,
          port: service.port,
        });
        callback([...this.rooms.values()]);
      });
      this.browser.on('down', (service) => {
        this.rooms.delete(service.fqdn);
        callback([...this.rooms.values()]);
      });
    } catch (e) {
      onError(`자동 검색을 사용할 수 없습니다. 수동 연결을 사용하세요. ${String(e)}`);
    }
  }
  publish(room: Room): void {
    this.service?.stop();
    if (!this.bonjour) return;
    this.service = this.bonjour.publish({
      name: `LocalSync-${room.id.slice(0, 8)}`,
      type: 'localsync',
      port: room.port,
      txt: { id: room.id, name: room.name, code: room.code, fp: room.fingerprint },
    });
    this.service.on('error', () => {
      /* Manual connection remains available. */
    });
  }
  unpublish(): void {
    this.service?.stop();
    this.service = undefined;
  }
  close(): void {
    this.unpublish();
    this.browser?.stop();
    this.bonjour?.destroy();
  }
}
