export type Theme = 'light' | 'dark';
export interface Settings {
  theme: Theme; fontFamily: string; fontSize: number; autoClipboard: boolean; autoStart: boolean;
}
export interface Device {
  id: string; name: string; os: string; publicKey: string; trusted: boolean;
  online: boolean; lastSeen: number; isHost: boolean;
}
export interface Room {
  id: string; name: string; code: string; hostId: string; host: string; port: number;
  fingerprint: string; role: 'host' | 'member';
}
export interface DiscoveredRoom {
  id: string; name: string; code: string; host: string; port: number; fingerprint: string;
}
export interface Clip {
  id: string; originId: string; originName: string; text: string; createdAt: number; pinned: boolean;
}
export interface JoinRequest { id: string; name: string; os: string; safetyCode: string }
export type Connection = 'idle' | 'hosting' | 'connecting' | 'approval' | 'connected' | 'offline' | 'rejected';
export interface AppState {
  device: Pick<Device, 'id' | 'name' | 'os'>; settings: Settings; room: Room | null;
  devices: Device[]; clips: Clip[]; requests: JoinRequest[]; discovered: DiscoveredRoom[];
  connection: Connection; error: string | null; safetyCode: string | null;
  addresses: string[]; storageProtected: boolean;
}
export type Command =
  | { type: 'create'; name: string }
  | { type: 'join'; code: string; address?: string; fingerprint?: string; roomId?: string }
  | { type: 'approve'; id: string; accept: boolean }
  | { type: 'removeDevice'; id: string }
  | { type: 'rename'; name: string }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'copyClip'; id: string }
  | { type: 'copyText'; text: string }
  | { type: 'shareClip'; text: string }
  | { type: 'deleteClip'; id: string }
  | { type: 'pinClip'; id: string }
  | { type: 'clearClips' }
  | { type: 'dismissError' }
  | { type: 'leave' }
  | { type: 'reconnect' }
  | { type: 'exportNote' };
export interface DesktopApi {
  state(): Promise<AppState>;
  command(command: Command): Promise<void>;
  document(): Promise<{ data: number[]; revision: number }>;
  update(data: number[], revision: number): void;
  onState(callback: (state: AppState) => void): () => void;
  onUpdate(callback: (update: { data: number[]; revision: number }) => void): () => void;
  onReset(callback: () => void): () => void;
}
