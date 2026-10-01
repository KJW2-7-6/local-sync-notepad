import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppService } from '../src/core/service';
import { LanDiscovery } from '../src/core/discovery';
import { fixture, until } from './helpers';

test('실제 mDNS 자동 검색: 방 번호만 입력해 방장을 찾고 승인 후 연결한다', async () => {
  const h = fixture(), c = fixture();
  const host = new AppService(h.store, h.clipboard, { discovery: new LanDiscovery(), preferredPort: 0 });
  const client = new AppService(c.store, c.clipboard, { discovery: new LanDiscovery() });
  try {
    await host.start(); await client.start(); await host.command({ type: 'create', name: '자동 검색 검사' });
    const room = host.state().room!;
    await until(() => client.state().discovered.some(r => r.id === room.id), 'mDNS announcement', 12000);
    await client.command({ type: 'join', code: room.code });
    await until(() => host.state().requests.length === 1);
    await host.command({ type: 'approve', id: client.state().device.id, accept: true });
    await until(() => client.state().connection === 'connected');
    assert.equal(client.state().room!.id, room.id);
  } finally { await client.close(); await host.close(); await c.cleanup(); await h.cleanup(); }
});
