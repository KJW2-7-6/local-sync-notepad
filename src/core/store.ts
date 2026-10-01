import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Identity, makeIdentity } from './crypto';
import { Clip, Device, Room, Settings } from '../shared/types';

export interface StoredState {
  version: 1; identity: Identity; settings: Settings; room: Room | null; devices: Device[];
  document: string; clips: Clip[]; certificate?: { cert: string; key: string; fingerprint: string };
}
export interface StorageCodec { protected: boolean; encode(value: string): Buffer; decode(value: Buffer): string }
const plaintext: StorageCodec = { protected: false, encode: s => Buffer.from(s), decode: b => b.toString() };
export class Store {
  readonly path: string;
  data: StoredState;
  recovered = false;
  constructor(directory: string, readonly codec: StorageCodec = plaintext) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'state.bin');
    let saved: StoredState | undefined;
    for (const path of [this.path, `${this.path}.bak`]) {
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(codec.decode(readFileSync(path)));
        if (parsed.version !== 1 || !parsed.identity?.privateKey || !Array.isArray(parsed.devices) || !parsed.settings) throw new Error('Invalid store');
        saved = parsed; this.recovered = path.endsWith('.bak'); break;
      } catch { /* Try the last complete backup; never replace both invalid files silently. */ }
    }
    if (!saved && (existsSync(this.path) || existsSync(`${this.path}.bak`))) {
      throw new Error('저장 파일을 읽을 수 없습니다. 앱 데이터의 state.bin 및 .bak 파일을 보존한 뒤 복구가 필요합니다.');
    }
    this.data = saved ?? {
      version: 1, identity: makeIdentity(), room: null, devices: [], document: '', clips: [],
      settings: { theme: 'light', fontFamily: 'Malgun Gothic', fontSize: 16, autoClipboard: false, autoStart: false },
    };
    if (!saved) this.save();
  }
  save(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, this.codec.encode(JSON.stringify(this.data)), { mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(this.path) && !this.recovered) { copyFileSync(this.path, `${this.path}.bak`); chmodSync(`${this.path}.bak`, 0o600); }
    renameSync(temporary, this.path); this.recovered = false;
  }
}
