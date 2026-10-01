import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { ClipboardSync } from '../src/core/clipboard';
import { makeIdentity, checkProof, prove, roomCode } from '../src/core/crypto';
import { Store } from '../src/core/store';
import { parseAddress } from '../src/core/service';
import { fixture, MemoryClipboard } from './helpers';

test('기기 인증: 잘못된 키와 이전 연결의 서명 재사용은 거부한다', () => {
  const a = makeIdentity(), b = makeIdentity();
  const signature = prove(a, 'nonce-a', 'room-a');
  assert.ok(checkProof(a.publicKey, a.id, 'nonce-a', 'room-a', signature));
  assert.equal(checkProof(b.publicKey, a.id, 'nonce-a', 'room-a', signature), false);
  assert.equal(checkProof(a.publicKey, a.id, 'nonce-b', 'room-a', signature), false);
  assert.equal(checkProof(a.publicKey, a.id, 'nonce-a', 'room-b', signature), false);
});
test('방 번호와 LAN 주소 검증', () => {
  for (let n = 0; n < 100; n++) assert.match(roomCode(), /^[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  assert.deepEqual(parseAddress('192.168.0.12:48765'), { host: '192.168.0.12', port: 48765 });
  for (const bad of ['https://evil.com', '8.8.8.8:80', '192.168.300.1:8', '127.0.0.1:0', '127.0.0.1:99999', '127.0.0.1:8/path']) assert.throws(() => parseAddress(bad));
});
test('클립보드: 수신·재복사·중복 메시지가 반복 전송되지 않는다', () => {
  const a = new MemoryClipboard(), b = new MemoryClipboard();
  const sentA: any[] = [], sentB: any[] = [];
  const ca = new ClipboardSync(a, () => ({ id: 'a', name: 'PC-A' }), clip => sentA.push(clip));
  const cb = new ClipboardSync(b, () => ({ id: 'b', name: 'PC-B' }), clip => sentB.push(clip));
  a.text = '한글\nhello\nhttps://example.com'; ca.poll(true);
  assert.equal(sentA.length, 1); assert.ok(cb.receive(sentA[0], true));
  for (let n = 0; n < 100; n++) { ca.poll(true); cb.poll(true); }
  assert.equal(sentB.length, 0); assert.equal(cb.receive(sentA[0], true), false); assert.equal(b.writes, 1);
  cb.copy(b.text); cb.poll(true); assert.equal(sentB.length, 0);
  b.text = 'new'; cb.poll(false); cb.poll(true); assert.equal(sentB.length, 0);
  b.text = 'other'; cb.poll(true); assert.equal(sentB.length, 1);
});
test('저장: 재실행, 정상 백업 복구, 둘 다 손상되면 조용히 초기화하지 않는다', async () => {
  const f = fixture();
  try {
    f.store.data.settings.fontSize = 24; f.store.data.identity.name = 'TEST-PC'; f.store.save(); f.store.save();
    const loaded = new Store(f.path);
    assert.equal(loaded.data.identity.id, f.store.data.identity.id); assert.equal(loaded.data.settings.fontSize, 24);
    writeFileSync(loaded.path, 'broken');
    const restored = new Store(f.path); assert.equal(restored.recovered, true); assert.equal(restored.data.identity.name, 'TEST-PC'); restored.save();
    assert.equal(new Store(f.path).data.identity.name, 'TEST-PC');
    writeFileSync(restored.path, 'broken'); writeFileSync(restored.path + '.bak', 'broken');
    assert.throws(() => new Store(f.path), /복구/);
    assert.equal(readFileSync(restored.path, 'utf8'), 'broken');
  } finally { await f.cleanup(); }
});
