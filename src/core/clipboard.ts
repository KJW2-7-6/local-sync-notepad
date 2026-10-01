import { randomUUID } from 'node:crypto';
import { digest } from './crypto';
import type { Clip } from '../shared/types';

export interface ClipboardPort {
  readText(): string;
  writeText(text: string): void;
}
export const MAX_CLIP_BYTES = 256 * 1024;
export class ClipboardSync {
  private lastHash: string;
  private seen = new Set<string>();
  constructor(
    private port: ClipboardPort,
    private device: () => { id: string; name: string },
    private publish: (clip: Clip) => void,
  ) {
    this.lastHash = digest(port.readText());
  }
  poll(enabled: boolean): void {
    const text = this.port.readText(),
      hash = digest(text);
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    if (enabled && text && Buffer.byteLength(text) <= MAX_CLIP_BYTES) this.share(text);
  }
  share(text: string): Clip {
    if (!text || Buffer.byteLength(text) > MAX_CLIP_BYTES)
      throw new Error('텍스트는 비어 있지 않은 256KB 이하여야 합니다.');
    const device = this.device();
    const clip = {
      id: randomUUID(),
      originId: device.id,
      originName: device.name,
      text,
      createdAt: Date.now(),
      pinned: false,
    };
    this.remember(clip.id);
    this.publish(clip);
    return clip;
  }
  receive(clip: Clip, apply: boolean): boolean {
    if (this.seen.has(clip.id)) return false;
    this.remember(clip.id);
    if (apply) this.copy(clip.text);
    return true;
  }
  copy(text: string): void {
    this.port.writeText(text);
    this.lastHash = digest(text);
  }
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
  }
}
