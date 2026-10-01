import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { AppService } from '../src/core/service';
import { Store } from '../src/core/store';
import { makeIdentity, prove } from '../src/core/crypto';
import { editor, fixture, joinRoom, noDiscovery, until } from './helpers';

test('실제 암호화 LAN 소켓: 승인 전 내용 차단, 확인 번호 일치, 거절', async () => {
  const h = fixture(), c = fixture();
  const ed = editor(h.service);
  try {
    await h.service.start(); await c.service.start(); await h.service.command({ type: 'create', name: '우리의 방' });
    ed.text.insert(0, '승인 전에는 비밀');
    const room = h.service.state().room!;
    await c.service.command({ type: 'join', code: room.code, address: `127.0.0.1:${room.port}` });
    await until(() => h.service.state().requests.length === 1 && !!c.service.state().safetyCode);
    assert.equal(c.service.text(), ''); assert.equal(c.service.state().clips.length, 0);
    assert.equal(h.service.state().requests[0].safetyCode, c.service.state().safetyCode);
    await h.service.command({ type: 'approve', id: c.service.state().device.id, accept: false });
    await until(() => c.service.state().connection === 'rejected');
    assert.equal(c.service.text(), ''); assert.equal(c.service.state().room, null);
  } finally { ed.close(); await c.cleanup(); await h.cleanup(); }
});

test('3개 기기: 입력, 선택 교체, 긴 붙여넣기, 같은/다른 위치 동시 수정이 모두 합쳐진다', async () => {
  const h = fixture(), a = fixture(), b = fixture();
  const eh = editor(h.service), ea = editor(a.service), eb = editor(b.service);
  try {
    await Promise.all([h.service.start(), a.service.start(), b.service.start()]);
    await h.service.command({ type: 'create', name: '동시 편집' });
    await joinRoom(h.service, a.service); await joinRoom(h.service, b.service);
    for (const text of ['안', '녕', '하', '세', '요', '\nHello 123\n']) {
      ea.text.insert(ea.text.length, text);
      await until(() => h.service.text() === a.service.text() && b.service.text() === a.service.text(), 'each keystroke');
    }
    assert.equal(h.service.text(), '안녕하세요\nHello 123\n');
    ea.text.delete(0, 5); ea.text.insert(0, '선택 후 교체');
    await until(() => h.service.text() === a.service.text() && b.service.text() === a.service.text());
    const long = '\n한글 English 0123456789\n여러 줄 붙여넣기\n'.repeat(1500);
    eb.text.insert(eb.text.length, long);
    await until(() => h.service.text() === b.service.text() && a.service.text() === b.service.text());
    assert.ok(h.service.text().includes(long));
    ea.text.insert(0, '[앞]'); eb.text.insert(eb.text.length, '[뒤]');
    await until(() => h.service.text() === a.service.text() && b.service.text() === a.service.text());
    assert.ok(h.service.text().startsWith('[앞]')); assert.ok(h.service.text().endsWith('[뒤]'));
    for (let n = 0; n < 20; n++) {
      ea.text.insert(0, `A${n}`); eb.text.insert(0, `B${n}`);
      await until(() => h.service.text() === a.service.text() && b.service.text() === a.service.text());
      assert.ok(h.service.text().includes(`A${n}`)); assert.ok(h.service.text().includes(`B${n}`));
    }
    ea.text.delete(0, 1); eb.text.delete(0, 1);
    await until(() => h.service.text() === a.service.text() && b.service.text() === a.service.text());
    await assert.rejects(() => a.service.command({ type: 'removeDevice', id: b.service.state().device.id }), /방장/);
  } finally { eh.close(); ea.close(); eb.close(); await b.cleanup(); await a.cleanup(); await h.cleanup(); }
});

test('연결 끊김/방장 재실행: 오프라인 변경 병합, 신뢰 기기 자동 재연결, 메모·설정 보존', async () => {
  const h = fixture(), a = fixture(); const eh = editor(h.service), ea = editor(a.service);
  let restarted: AppService | undefined;
  try {
    await h.service.start(); await a.service.start(); await h.service.command({ type: 'create', name: '복구 방' }); await joinRoom(h.service, a.service);
    ea.text.insert(0, '처음 메모'); await until(() => h.service.text() === '처음 메모');
    await a.service.command({ type: 'rename', name: 'LAPTOP-TEST' });
    await a.service.command({ type: 'settings', settings: { theme: 'dark', fontFamily: 'Consolas', fontSize: 20, autoClipboard: true } });
    await until(() => h.service.state().devices.some(d => d.name === 'LAPTOP-TEST'));
    await h.service.close(); await until(() => a.service.state().connection === 'offline');
    ea.text.insert(ea.text.length, '\n오프라인에서 추가'); a.service.flush();
    assert.equal(new Store(a.path).data.settings.theme, 'dark');
    restarted = new AppService(new Store(h.path), h.clipboard, { discovery: noDiscovery });
    await restarted.start();
    await until(() => a.service.state().connection === 'connected', 'automatic trusted reconnect');
    await until(() => restarted!.text() === a.service.text(), 'offline merge');
    assert.equal(restarted.state().requests.length, 0); assert.ok(restarted.text().includes('오프라인에서 추가'));
    assert.equal(restarted.state().room!.name, '복구 방'); assert.ok(restarted.state().devices.some(d => d.name === 'LAPTOP-TEST' && d.trusted));
  } finally { eh.close(); ea.close(); await restarted?.close(); await a.cleanup(); await h.cleanup(); }
});

test('실제 소켓 클립보드: 원본 표시·양방향 전달·반복 방지·고정/삭제/재복사/저장', async () => {
  const h = fixture(), a = fixture();
  try {
    await h.service.start(); await a.service.start(); await h.service.command({ type: 'create', name: '클립보드 방' }); await joinRoom(h.service, a.service);
    for (const f of [h, a]) await f.service.command({ type: 'settings', settings: { autoClipboard: true } });
    h.clipboard.text = 'npm install\nhttps://example.com';
    await until(() => a.clipboard.text === h.clipboard.text && a.service.state().clips.length === 1);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(h.service.state().clips.length, 1); assert.equal(a.service.state().clips[0].originId, h.service.state().device.id);
    assert.equal(a.clipboard.writes, 1);
    a.clipboard.text = '노트북에서 복사'; await until(() => h.clipboard.text === '노트북에서 복사');
    assert.equal(h.service.state().clips.length, 2);
    const id = h.service.state().clips[0].id;
    await h.service.command({ type: 'pinClip', id }); await h.service.command({ type: 'copyClip', id });
    await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(a.service.state().clips.length, 2);
    assert.equal(new Store(h.path).data.clips.find(c => c.id === id)!.pinned, true);
    await h.service.command({ type: 'deleteClip', id }); assert.equal(h.service.state().clips.length, 1); assert.equal(a.service.state().clips.length, 2);
    await a.service.command({ type: 'settings', settings: { autoClipboard: false } });
    await h.service.command({ type: 'shareClip', text: '자동 공유 OFF에도 기록은 받음' });
    await until(() => a.service.state().clips.length === 3); assert.equal(a.clipboard.text, '노트북에서 복사');
    await h.service.command({ type: 'clearClips' }); assert.equal(h.service.state().clips.length, 0);
  } finally { await a.cleanup(); await h.cleanup(); }
});

test('신뢰 해제는 연결을 끊고 재접속 시 새 승인을 요구한다', async () => {
  const h = fixture(), a = fixture();
  try {
    await h.service.start(); await a.service.start(); await h.service.command({ type: 'create', name: '제거 방' }); await joinRoom(h.service, a.service);
    const id = a.service.state().device.id;
    await h.service.command({ type: 'removeDevice', id });
    await until(() => a.service.state().connection === 'rejected');
    assert.equal(h.service.state().devices.some(d => d.id === id), false);
    await a.service.command({ type: 'reconnect' }); await until(() => h.service.state().requests.length === 1);
    await h.service.command({ type: 'approve', id, accept: true }); await until(() => a.service.state().connection === 'connected');
  } finally { await a.cleanup(); await h.cleanup(); }
});

test('보안: 잘못된 방장 인증서 차단, 승인 기기의 ID만 도용해도 자동 승인되지 않는다', async () => {
  const h = fixture(), a = fixture(), impostor = fixture();
  try {
    await h.service.start(); await a.service.start(); await impostor.service.start(); await h.service.command({ type: 'create', name: '보안 방' }); await joinRoom(h.service, a.service);
    const room = h.service.state().room!;
    await impostor.service.command({ type: 'join', code: room.code, address: `127.0.0.1:${room.port}`, fingerprint: 'f'.repeat(64) });
    await until(() => impostor.service.state().connection === 'rejected'); assert.equal(impostor.service.text(), '');
    assert.match(impostor.service.state().error!, /인증서/);
    const stolen = makeIdentity(); stolen.id = a.service.state().device.id;
    const ws = new WebSocket(`wss://127.0.0.1:${room.port}`, { rejectUnauthorized: false });
    const messages: any[] = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString()); messages.push(msg);
      if (msg.type === 'challenge') ws.send(JSON.stringify({ type: 'hello', code: room.code, device: { id: stolen.id, publicKey: stolen.publicKey, name: 'IMPOSTOR', os: 'win32' }, proof: prove(stolen, msg.nonce, room.id) }));
    });
    await until(() => messages.some(m => m.type === 'pending'));
    assert.equal(messages.some(m => m.type === 'ready' || m.type === 'update' || m.type === 'clipboard'), false);
    await h.service.command({ type: 'approve', id: stolen.id, accept: false }); ws.terminate();
    assert.equal(h.service.state().devices.find(d => d.id === stolen.id)!.publicKey, a.store.data.identity.publicKey);
  } finally { await impostor.cleanup(); await a.cleanup(); await h.cleanup(); }
});
