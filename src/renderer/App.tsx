import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clipboard,
  Copy,
  FileText,
  Laptop,
  Link,
  LoaderCircle,
  Monitor,
  Moon,
  Pin,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
  Download,
  LogOut,
} from 'lucide-react';
import { AppState, Command } from '../shared/types';
import { Editor } from './Editor';

type Tab = 'note' | 'clipboard' | 'devices' | 'settings';
const osName = (os: string) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[os] ?? os;
const statusNames = {
  idle: '방에 연결되지 않음',
  hosting: '방장 · 연결 중',
  connecting: '연결하는 중',
  approval: '방장 승인 기다리는 중',
  connected: 'LAN 연결됨',
  offline: '연결 끊김 · 로컬 편집 가능',
  rejected: '연결 승인 필요',
};
function friendlyDate(time: number) {
  return new Date(time).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function App() {
  const [state, setState] = useState<AppState>();
  const [tab, setTab] = useState<Tab>('note');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [createName, setCreateName] = useState('우리의 메모방');
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [count, setCount] = useState(0);
  const [draft, setDraft] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [qr, setQr] = useState('');
  const [confirm, setConfirm] = useState<{ text: string; command: Command }>();
  useEffect(() => {
    const stop = window.desktop.onState(setState);
    void window.desktop
      .state()
      .then(setState)
      .catch((e) => setError(String(e)));
    return stop;
  }, []);
  useEffect(() => {
    if (state) document.documentElement.dataset.theme = state.settings.theme;
  }, [state?.settings.theme]);
  useEffect(() => {
    if (state) setDeviceName(state.device.name);
  }, [state?.device.name]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  const room = state?.room;
  const localAddress = room
    ? `${room.role === 'host' ? (state?.addresses[0] ?? room.host) : room.host}:${room.port}`
    : '';
  const invite = room
    ? `localsync://join?code=${encodeURIComponent(room.code)}&address=${encodeURIComponent(localAddress)}&fingerprint=${room.fingerprint}&room=${room.id}`
    : '';
  useEffect(() => {
    let active = true;
    if (invite)
      void QRCode.toDataURL(invite, {
        width: 224,
        margin: 2,
        color: { dark: '#102d3d', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      }).then((url) => {
        if (active) setQr(url);
      });
    return () => {
      active = false;
    };
  }, [invite]);
  async function run(command: Command, message?: string) {
    setError('');
    setBusy(true);
    try {
      await window.desktop.command(command);
      if (message) setToast(message);
      return true;
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method '[^']+': Error: /,
          '',
        ),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  function join() {
    try {
      if (code.trim().startsWith('localsync://')) {
        const url = new URL(code.trim());
        if (url.hostname !== 'join') throw new Error('참가용 링크가 아닙니다.');
        void run({
          type: 'join',
          code: url.searchParams.get('code') ?? '',
          address: url.searchParams.get('address') ?? '',
          fingerprint: url.searchParams.get('fingerprint') ?? undefined,
          roomId: url.searchParams.get('room') ?? undefined,
        });
      } else
        void run({ type: 'join', code, ...(address.trim() ? { address: address.trim() } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function readQr(file?: File) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('QR 이미지는 5MB 이하로 선택하세요.');
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result?.data.startsWith('localsync://join?'))
        throw new Error(
          '이 프로그램의 참가용 QR 코드를 찾지 못했습니다. 번호를 직접 입력할 수도 있습니다.',
        );
      setCode(result.data);
      setAddress('');
      setToast('QR 참가 정보를 읽었습니다. 참가 요청하기를 누르세요.');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (!state)
    return (
      <div className="loading">
        <LoaderCircle className="spin" /> 프로그램을 준비하고 있습니다… {error}
      </div>
    );
  const connected = ['hosting', 'connected'].includes(state.connection);
  const online = state.devices.filter((d) => d.online).length;
  const host = room?.role === 'host';
  const tabs = [
    { id: 'note', title: '공동 메모', icon: FileText },
    { id: 'clipboard', title: '클립보드', icon: Clipboard },
    { id: 'devices', title: '기기 관리', icon: Users },
    { id: 'settings', title: '설정', icon: SettingsIcon },
  ] as const;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <FileText size={24} />
            <span />
          </div>
          <div>
            Local Sync<small>생각을 함께, 연결은 가까이.</small>
          </div>
        </div>
        <div className="room-card">
          <span className="eyebrow">WORKSPACE</span>
          <strong>{room?.name ?? '나의 로컬 공간'}</strong>
          <span className={connected ? 'connection good' : 'connection'}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            {statusNames[state.connection]}
          </span>
          {room && <span className="room-code-mini">{room.code}</span>}
        </div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              aria-label={t.title}
              className={`nav-button ${tab === t.id ? 'selected' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={19} />
              {t.title}
              {t.id === 'devices' && room && <span className="nav-count">{online}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy">
            <ShieldCheck size={17} />
            <span>
              가까운 연결, 안전한 공유<small>중앙 서버 없이 LAN 안에서</small>
            </span>
          </div>
          <div className="my-device">
            <div className="avatar">
              <Monitor size={18} />
            </div>
            <div>
              <strong>{state.device.name}</strong>
              <small>이 컴퓨터 · {osName(state.device.os)}</small>
            </div>
            <button
              className="icon-button"
              aria-label="테마 전환"
              onClick={() =>
                void run({
                  type: 'settings',
                  settings: { theme: state.settings.theme === 'dark' ? 'light' : 'dark' },
                })
              }
            >
              {state.settings.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            내 작업 공간
            <ChevronRight size={14} />
            <strong>{tabs.find((t) => t.id === tab)!.title}</strong>
          </div>
          <div className="topbar-right">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            {room ? `${online}대 연결` : '로컬 저장'}
            <span className="divider" />
            v0.1.0
          </div>
        </header>
        {(error || state.error) && (
          <div className="error-banner" role="alert">
            {error || state.error}
            <button
              aria-label="오류 닫기"
              className="icon-button"
              onClick={() => {
                setError('');
                void run({ type: 'dismissError' });
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {state.connection === 'approval' && (
          <div className="approval-banner">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>방장에게 참가 승인을 요청했습니다.</strong>
              <p>
                두 화면의 확인 번호 <b className="mono">{state.safetyCode}</b>가 같은지 확인하세요.
                승인 전에는 방 내용을 받지 않습니다.
              </p>
            </div>
          </div>
        )}
        {state.requests.length > 0 && (
          <div className="requests">
            {state.requests.map((request) => (
              <div className="request" key={request.id}>
                <ShieldCheck size={22} />
                <div>
                  <strong>{request.name} 기기가 참가하려고 합니다.</strong>
                  <p>
                    {osName(request.os)} · 확인 번호 <b className="mono">{request.safetyCode}</b> ·
                    상대 화면의 번호가 같을 때 승인하세요.
                  </p>
                </div>
                <button
                  onClick={() => void run({ type: 'approve', id: request.id, accept: false })}
                  className="button secondary"
                >
                  거절
                </button>
                <button
                  onClick={() => void run({ type: 'approve', id: request.id, accept: true })}
                  className="button primary"
                >
                  <Check size={16} />
                  승인
                </button>
              </div>
            ))}
          </div>
        )}
        {state.connection === 'offline' && (
          <div className="offline-banner">
            연결이 끊겼습니다. 메모는 이 PC에 저장하고 연결이 돌아오면 합칩니다.
            <button className="text-button" onClick={() => void run({ type: 'reconnect' })}>
              지금 재연결
            </button>
          </div>
        )}
        {!room ? (
          <section className="welcome content-scroll">
            <div className="welcome-heading">
              <span className="pill">
                <Wifi size={13} />
                같은 네트워크, 하나의 작업 공간
              </span>
              <h1>
                두 컴퓨터 사이,
                <br />
                <em>생각은 끊기지 않도록.</em>
              </h1>
              <p>
                함께 쓰는 메모와 빠른 클립보드.
                <br />
                계정 없이, 인터넷 없이, 가까운 PC를 연결하세요.
              </p>
            </div>
            <div className="welcome-cards">
              <form
                className="card join-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run({ type: 'create', name: createName });
                }}
              >
                <div className="card-icon">
                  <Plus size={23} />
                </div>
                <h2>새 방 만들기</h2>
                <p>
                  이 컴퓨터에서 작업 공간을 시작합니다.
                  <br />
                  다른 기기의 참가를 직접 승인하세요.
                </p>
                <label>
                  방 이름
                  <input
                    aria-label="방 이름"
                    maxLength={60}
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="우리의 메모방"
                  />
                </label>
                <button disabled={busy} className="button primary wide" type="submit">
                  방 만들기
                  <ArrowRight size={17} />
                </button>
              </form>
              <form
                className="card join-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  join();
                }}
              >
                <div className="card-icon neutral">
                  <Link size={23} />
                </div>
                <h2>기존 방 참가하기</h2>
                <p>
                  방 번호를 입력하면 LAN에서 찾습니다.
                  <br />
                  검색이 안 되면 연결 주소도 입력하세요.
                </p>
                <label>
                  방 번호 또는 QR 참가 링크
                  <input
                    aria-label="방 번호"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="A7K2-91"
                    autoCapitalize="characters"
                  />
                </label>
                <label>
                  수동 연결 주소 <span className="optional">선택</span>
                  <input
                    aria-label="수동 연결 주소"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="192.168.0.10:48765"
                  />
                </label>
                <button disabled={busy || !code} className="button secondary wide" type="submit">
                  참가 요청하기
                  <ArrowRight size={17} />
                </button>
                <label className="qr-import text-button">
                  <Download size={14} />
                  QR 이미지 불러오기
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="QR 이미지 불러오기"
                    onChange={(e) => {
                      void readQr(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </form>
            </div>
            {state.discovered.length > 0 && (
              <div className="nearby">
                <span className="eyebrow">가까이 있는 메모방</span>
                {state.discovered.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setCode(r.code);
                      setAddress(`${r.host}:${r.port}`);
                    }}
                  >
                    <Wifi size={16} />
                    <strong>{r.name}</strong>
                    <span className="mono">{r.code}</span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            )}
            <p className="welcome-foot">
              <ShieldCheck size={14} /> 같은 Wi-Fi에 있어도, 승인한 기기만 메모와 클립보드에
              접근합니다.
            </p>
          </section>
        ) : (
          <>
            {tab === 'note' && (
              <section className="note-page">
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">SHARED NOTE</span>
                    <h1>공동 메모</h1>
                    <p>아이디어부터 할 일까지, 함께 적어보세요.</p>
                  </div>
                  <div className="avatars" title="온라인 기기">
                    <div className="avatar small">
                      <Monitor size={17} />
                    </div>
                    {online > 1 && (
                      <div className="avatar small green">
                        <Laptop size={17} />
                      </div>
                    )}
                    <span>
                      {online > 1 ? `${online}명이 함께 쓰는 중` : '나의 작업을 기다리는 공간'}
                    </span>
                  </div>
                </div>
                <div className="note-card">
                  <div className="editor-toolbar">
                    <div className="document-name">
                      <FileText size={17} />
                      공동 메모.txt
                      <span className="saved">
                        <Check size={12} />
                        자동 저장
                      </span>
                    </div>
                    <div className="format-controls">
                      <select
                        aria-label="글씨체"
                        value={state.settings.fontFamily}
                        onChange={(e) =>
                          void run({ type: 'settings', settings: { fontFamily: e.target.value } })
                        }
                      >
                        <option value="Malgun Gothic">맑은 고딕</option>
                        <option value="Segoe UI">Segoe UI</option>
                        <option value="Arial">Arial</option>
                        <option value="Consolas">Consolas · 코드</option>
                        <option value="Cascadia Code">Cascadia Code · 코드</option>
                      </select>
                      <select
                        aria-label="글자 크기"
                        value={state.settings.fontSize}
                        onChange={(e) =>
                          void run({
                            type: 'settings',
                            settings: { fontSize: Number(e.target.value) },
                          })
                        }
                      >
                        {[12, 14, 16, 18, 20, 24, 28, 32].map((s) => (
                          <option key={s} value={s}>
                            {s} px
                          </option>
                        ))}
                      </select>
                      <button
                        aria-label="메모 내보내기"
                        title="텍스트 파일로 내보내기"
                        className="icon-button"
                        onClick={() => void run({ type: 'exportNote' })}
                      >
                        <Download size={17} />
                      </button>
                    </div>
                  </div>
                  <div className="editor-wrap">
                    <Editor settings={state.settings} onLength={setCount} />
                    {count === 0 && (
                      <div className="editor-placeholder">
                        여기서 함께 적기 시작하세요.
                        <span>변경한 내용은 연결된 PC에 바로 전달됩니다.</span>
                      </div>
                    )}
                  </div>
                  <footer className="editor-footer">
                    <span>
                      {count.toLocaleString()}자<span className="footer-dot">·</span>UTF-8
                    </span>
                    <span>
                      <span className={`status-dot ${connected ? 'online' : ''}`} />
                      {connected ? 'LAN으로 실시간 동기화' : '이 PC에 저장 중'}
                      <span className="footer-dot">·</span>2MB까지
                    </span>
                  </footer>
                </div>
                <div className="note-tip">
                  <ShieldCheck size={15} />
                  메모는 내 PC에 저장됩니다. 방장 PC가 켜져 있으면 서로의 변경이 바로 이어집니다.
                </div>
              </section>
            )}
            {tab === 'clipboard' && (
              <section className="content-scroll">
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">QUICK TRANSFER</span>
                    <h1>클립보드</h1>
                    <p>텍스트, 코드, 링크를 가까운 PC로 바로 보내세요.</p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() =>
                      setConfirm({
                        text: '이 PC의 클립보드 기록을 모두 지울까요? 다른 PC의 기록은 유지됩니다.',
                        command: { type: 'clearClips' },
                      })
                    }
                  >
                    <Trash2 size={15} />
                    전체 삭제
                  </button>
                </div>
                <div className="card auto-clipboard">
                  <div>
                    <h3>자동 클립보드 공유</h3>
                    <p>
                      켜면 이 PC에서 복사한 텍스트를 보내고, 받은 텍스트를 시스템 클립보드에
                      넣습니다.
                      <br />
                      비밀번호 등 민감한 텍스트도 전달될 수 있습니다. 필요한 동안만 켜세요.
                    </p>
                  </div>
                  <Toggle
                    label="자동 클립보드 공유"
                    on={state.settings.autoClipboard}
                    change={(value) =>
                      void run({ type: 'settings', settings: { autoClipboard: value } })
                    }
                  />
                </div>
                <form
                  className="card clipboard-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run({ type: 'shareClip', text: draft }, '텍스트를 보냈습니다.').then(
                      (ok) => {
                        if (ok) setDraft('');
                      },
                    );
                  }}
                >
                  <label>
                    직접 보내기
                    <textarea
                      aria-label="보낼 텍스트"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="다른 PC에서 사용할 텍스트나 링크를 넣으세요."
                      rows={3}
                    />
                  </label>
                  <button
                    disabled={!draft || !connected || busy}
                    className="button primary"
                    type="submit"
                  >
                    텍스트 보내기
                    <ArrowRight size={16} />
                  </button>
                </form>
                <div className="section-label">
                  최근 기록 <span>{state.clips.length}/100</span>
                  <small>고정·삭제는 이 PC의 기록에 적용됩니다.</small>
                </div>
                {!state.clips.length && (
                  <div className="empty-state">
                    <Clipboard size={36} />
                    <h3>아직 공유한 텍스트가 없습니다.</h3>
                    <p>텍스트를 직접 보내거나 자동 공유를 켜고 복사해보세요.</p>
                  </div>
                )}
                <div className="clip-list">
                  {state.clips.map((clip) => (
                    <article className="card clip-card" key={clip.id}>
                      <div className="clip-meta">
                        <span className="avatar tiny">
                          <Monitor size={13} />
                        </span>
                        <strong>{clip.originName}</strong>
                        {clip.originId === state.device.id && <span className="tag">이 PC</span>}
                        {clip.pinned && (
                          <span className="tag accent">
                            <Pin size={11} />
                            고정
                          </span>
                        )}
                        <time>{friendlyDate(clip.createdAt)}</time>
                      </div>
                      <button
                        className="clip-text"
                        title="클릭하여 복사"
                        onClick={() =>
                          void run(
                            { type: 'copyClip', id: clip.id },
                            '이 PC의 클립보드에 복사했습니다.',
                          )
                        }
                      >
                        {clip.text}
                      </button>
                      <div className="clip-actions">
                        <button
                          className="text-button"
                          onClick={() =>
                            void run({ type: 'copyClip', id: clip.id }, '복사했습니다.')
                          }
                        >
                          <Copy size={14} />
                          복사
                        </button>
                        <button
                          aria-label={clip.pinned ? '고정 해제' : '항목 고정'}
                          className={`icon-button ${clip.pinned ? 'active' : ''}`}
                          onClick={() => void run({ type: 'pinClip', id: clip.id })}
                        >
                          <Pin size={15} />
                        </button>
                        <button
                          aria-label="항목 삭제"
                          className="icon-button"
                          onClick={() => void run({ type: 'deleteClip', id: clip.id })}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
            {tab === 'devices' && (
              <section className="content-scroll">
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">TRUSTED CONNECTIONS</span>
                    <h1>기기 관리</h1>
                    <p>이 방에 함께하는 기기를 확인하고 관리합니다.</p>
                  </div>
                  <span className="pill">
                    <Users size={14} />
                    {online}대 온라인
                  </span>
                </div>
                <div className="card my-device-settings">
                  <Monitor size={25} />
                  <div>
                    <h3>이 컴퓨터의 이름</h3>
                    <p>다른 PC에 표시되는 이름입니다.</p>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run({ type: 'rename', name: deviceName }, '기기 이름을 저장했습니다.');
                    }}
                  >
                    <input
                      aria-label="기기 이름"
                      value={deviceName}
                      maxLength={60}
                      onChange={(e) => setDeviceName(e.target.value)}
                    />
                    <button className="button secondary" type="submit">
                      저장
                    </button>
                  </form>
                </div>
                <div className="section-label">
                  등록된 기기 <span>{state.devices.length}</span>
                </div>
                <div className="device-list">
                  {state.devices.map((device) => (
                    <article key={device.id} className="card device-card">
                      <div className={`device-icon ${device.online ? 'connected' : ''}`}>
                        {device.name.includes('LAPTOP') ? (
                          <Laptop size={24} />
                        ) : (
                          <Monitor size={24} />
                        )}
                      </div>
                      <div className="device-details">
                        <h3>
                          {device.name}
                          {device.id === state.device.id && <span className="tag">이 PC</span>}
                          {device.isHost && <span className="tag accent">방장</span>}
                        </h3>
                        <p>
                          {osName(device.os)}
                          <span className="footer-dot">·</span>
                          {device.trusted ? '신뢰 기기' : '승인 필요'}
                          <span className="footer-dot">·</span>
                          {device.online
                            ? '현재 연결됨'
                            : `마지막 연결 ${friendlyDate(device.lastSeen)}`}
                        </p>
                        <small className="mono">기기 ID {device.id.slice(0, 12)}</small>
                      </div>
                      <span className={`device-status ${device.online ? 'online' : ''}`}>
                        <span className={`status-dot ${device.online ? 'online' : ''}`} />
                        {device.online ? '온라인' : '오프라인'}
                      </span>
                      {host && device.id !== state.device.id && (
                        <button
                          aria-label={`${device.name} 제거`}
                          className="icon-button danger"
                          onClick={() =>
                            setConfirm({
                              text: `${device.name}의 신뢰를 해제하고 방에서 제거할까요? 다시 접속하려면 새 승인이 필요합니다.`,
                              command: { type: 'removeDevice', id: device.id },
                            })
                          }
                        >
                          <Trash2 size={17} />
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                <p className="note-tip">
                  <ShieldCheck size={15} />
                  신뢰한 기기는 다음부터 자동 연결됩니다. 방장만 다른 기기를 제거할 수 있습니다.
                </p>
              </section>
            )}
            {tab === 'settings' && (
              <section className="content-scroll settings-page">
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">MAKE IT YOURS</span>
                    <h1>설정</h1>
                    <p>편안한 화면과 안전한 연결을 나에게 맞게.</p>
                  </div>
                </div>
                <div className="settings-grid">
                  <div className="card room-settings">
                    <span className="eyebrow">방 정보</span>
                    <h2>{room.name}</h2>
                    <div className="large-code mono">
                      {room.code}
                      <button
                        className="icon-button"
                        aria-label="방 번호 복사"
                        onClick={() =>
                          void run({ type: 'copyText', text: room.code }, '방 번호를 복사했습니다.')
                        }
                      >
                        <Copy size={17} />
                      </button>
                    </div>
                    <p>
                      참가할 PC에서 이 번호를 입력하세요.
                      <br />
                      검색이 안 되면 아래 연결 주소도 입력합니다.
                    </p>
                    <div className="address-box">
                      <span>수동 연결 주소</span>
                      {(host ? state.addresses : [room.host]).map((a) => (
                        <button
                          key={a}
                          className="text-button mono"
                          onClick={() =>
                            void run(
                              { type: 'copyText', text: `${a}:${room.port}` },
                              '연결 주소를 복사했습니다.',
                            )
                          }
                        >
                          {a}:{room.port}
                          <Copy size={13} />
                        </button>
                      ))}
                    </div>
                    <div className="qr-wrap">
                      {qr && <img src={qr} alt="방 참가용 QR 코드" />}
                      <span>방 번호와 연결 정보를 담은 QR</span>
                      <div className="qr-actions">
                        <button
                          className="text-button"
                          onClick={() =>
                            void run(
                              { type: 'copyText', text: invite },
                              '참가 링크를 복사했습니다.',
                            )
                          }
                        >
                          <Copy size={14} />
                          참가 링크 복사
                        </button>
                        {qr && (
                          <a className="text-button" href={qr} download="local-sync-room-qr.png">
                            <Download size={14} />
                            QR 저장
                          </a>
                        )}
                      </div>
                    </div>
                    <p className="small-help">
                      QR을 읽은 PC에서는 참가 링크를 첫 화면에 붙여넣을 수 있습니다. 첫 접속은 방장
                      승인이 필요합니다.
                    </p>
                    <p className="small-help mono">인증서 {room.fingerprint.slice(0, 16)}…</p>
                  </div>
                  <div className="settings-stack">
                    <div className="card">
                      <h3>화면 모드</h3>
                      <p>오래 켜두어도 편안한 작업 공간.</p>
                      <div className="theme-options">
                        <button
                          className={state.settings.theme === 'light' ? 'selected' : ''}
                          onClick={() =>
                            void run({ type: 'settings', settings: { theme: 'light' } })
                          }
                        >
                          <Sun size={20} />
                          라이트 모드{state.settings.theme === 'light' && <Check size={16} />}
                        </button>
                        <button
                          className={state.settings.theme === 'dark' ? 'selected' : ''}
                          onClick={() =>
                            void run({ type: 'settings', settings: { theme: 'dark' } })
                          }
                        >
                          <Moon size={20} />
                          다크 모드{state.settings.theme === 'dark' && <Check size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="card setting-row">
                      <div>
                        <h3>Windows 시작 시 자동 실행</h3>
                        <p>설치 버전에서 지원합니다. 기본값은 OFF.</p>
                      </div>
                      <Toggle
                        label="Windows 시작 시 자동 실행"
                        on={state.settings.autoStart}
                        change={(value) =>
                          void run({ type: 'settings', settings: { autoStart: value } })
                        }
                      />
                    </div>
                    <div className="card">
                      <h3>연결 및 방화벽</h3>
                      <p>
                        두 PC를 같은 공유기에 연결하고 Windows 네트워크를 ‘개인’으로 설정하세요.
                        방화벽 창이 나오면 이 앱의 <b>개인 네트워크</b> 접근을 허용하세요.
                      </p>
                      <p className="small-help">
                        방장 TCP 포트: {room.port} · 자동 검색: UDP 5353
                        <br />
                        회사·게스트 Wi-Fi의 기기 간 통신 차단은 수동 연결에도 영향을 줍니다.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => void run({ type: 'reconnect' }, '연결을 다시 시도합니다.')}
                      >
                        <Wifi size={14} />
                        연결 다시 시작
                      </button>
                    </div>
                    <div className="card">
                      <h3>내 PC의 데이터</h3>
                      <p>
                        메모와 설정은 이 PC에 저장됩니다.{' '}
                        {state.storageProtected
                          ? 'Windows 보호 저장으로 로컬 파일도 암호화합니다.'
                          : '이 환경에는 OS 보호 저장이 없어 로컬 파일은 암호화하지 않습니다.'}
                      </p>
                      <p className="small-help">
                        클립보드: 텍스트 256KB, 최근 100개, 고정 30개.
                        <br />
                        방장이 꺼지면 LAN 전송은 멈춥니다. 이미 받은 데이터는 기기 제거 후에도 상대
                        PC에 남을 수 있습니다.
                      </p>
                    </div>
                    <button
                      className="button danger-outline"
                      onClick={() =>
                        setConfirm({
                          text: '이 방에서 나갈까요? 메모는 새 방을 만들거나 다른 방에 참가하기 전까지 이 PC에 보관됩니다. 필요한 메모는 먼저 내보내세요.',
                          command: { type: 'leave' },
                        })
                      }
                    >
                      <LogOut size={16} />방 나가기
                    </button>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {confirm && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-label="작업 확인">
            <h2>한 번 더 확인해주세요.</h2>
            <p>{confirm.text}</p>
            <div>
              <button className="button secondary" onClick={() => setConfirm(undefined)}>
                취소
              </button>
              <button
                className="button primary"
                onClick={() => {
                  void run(confirm.command);
                  setConfirm(undefined);
                }}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  on,
  change,
}: {
  label: string;
  on: boolean;
  change: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={() => change(!on)}
    >
      <span />
    </button>
  );
}
