import { test, expect, _electron, ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

const root = resolve('.');
async function launch(profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ args: [root, '--no-sandbox', '--e2e', `--profile=${profile}`], env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' }, timeout: 20000 });
  const page = await app.firstWindow();
  await page.locator('.app-shell').waitFor({ timeout: 15000 });
  return { app, page };
}
async function text(page: Page) { return page.locator('.cm-content').evaluate(dom => (dom as any).cmTile.root.view.state.doc.toString()); }

test('실제 Electron 2개: 방 생성·승인·공동 편집·한글 조합·QR·클립보드·설정·재실행', async () => {
  const profileA = mkdtempSync(join(tmpdir(), 'localsync-ui-a-'));
  const profileB = mkdtempSync(join(tmpdir(), 'localsync-ui-b-'));
  let a: Awaited<ReturnType<typeof launch>> | undefined, b: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    a = await launch(profileA); b = await launch(profileB);
    const errors: string[] = [];
    a.page.on('pageerror', error => errors.push(error.message)); b.page.on('pageerror', error => errors.push(error.message));
    await a.page.getByLabel('방 이름', { exact: true }).fill('데스크톱 검사방');
    await a.page.getByRole('button', { name: '방 만들기', exact: true }).click();
    await expect(a.page.getByRole('heading', { name: '공동 메모', exact: true })).toBeVisible();
    await a.page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(a.page.getByAltText('방 참가용 QR 코드')).toBeVisible();
    const stateA = await a.page.evaluate(() => window.desktop.state());
    const room = stateA.room!;
    const qrUrl = await a.page.getByAltText('방 참가용 QR 코드').getAttribute('src');
    await b.page.getByLabel('QR 이미지 불러오기').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: Buffer.from(qrUrl!.split(',')[1], 'base64') });
    await expect(b.page.getByLabel('방 번호', { exact: true })).toHaveValue(/^localsync:\/\/join\?/);
    await b.page.getByLabel('방 번호', { exact: true }).fill(room.code);
    await b.page.getByLabel('수동 연결 주소').fill(`127.0.0.1:${room.port}`);
    await b.page.getByRole('button', { name: '참가 요청하기' }).click();
    await expect(a.page.getByText(/기기가 참가하려고 합니다/)).toBeVisible();
    const stateB = await b.page.evaluate(() => window.desktop.state());
    expect(stateB.safetyCode).toBe((await a.page.evaluate(() => window.desktop.state())).requests[0].safetyCode);
    await a.page.getByRole('button', { name: '승인', exact: true }).click();
    await expect(b.page.getByRole('heading', { name: '공동 메모', exact: true })).toBeVisible();
    await a.page.getByRole('button', { name: '공동 메모', exact: true }).click();
    const editorA = a.page.getByRole('textbox', { name: '공동 메모 편집기' });
    const editorB = b.page.getByRole('textbox', { name: '공동 메모 편집기' });
    await editorA.click(); await a.page.keyboard.type('Hello 123');
    await expect.poll(() => text(b!.page)).toContain('Hello 123');
    await a.page.keyboard.press('Enter'); await a.page.keyboard.insertText('한글 입력\n여러 줄 붙여넣기\n'.repeat(300));
    await expect.poll(() => text(b!.page)).toContain('여러 줄 붙여넣기');
    await expect.poll(async () => (await text(a!.page)) === (await text(b!.page))).toBe(true);
    await editorA.click(); await a.page.keyboard.press('Control+Home'); await a.page.keyboard.press('Control+Shift+End'); await a.page.keyboard.insertText('선택 교체\n');
    await expect.poll(() => text(b!.page)).toContain('선택 교체');
    await expect.poll(async () => (await text(a!.page)) === (await text(b!.page))).toBe(true);
    await a.page.keyboard.press('Control+End');
    const cdp = await a.page.context().newCDPSession(a.page);
    for (let n = 0; n < 10; n++) {
      for (const syllable of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text: syllable, selectionStart: syllable.length, selectionEnd: syllable.length });
      await cdp.send('Input.insertText', { text: '한' });
    }
    await cdp.detach();
    await expect.poll(() => text(b!.page)).toContain('한'.repeat(10));
    expect((await text(a.page)).match(/한/g)?.length).toBe(10);
    await editorB.click(); await b.page.keyboard.press('Control+Home'); await b.page.keyboard.type('[B]');
    await editorA.click(); await a.page.keyboard.press('Control+End'); await a.page.keyboard.type('[A]');
    await expect.poll(async () => (await text(a!.page)) === (await text(b!.page))).toBe(true);
    await a.page.keyboard.press('Control+z');
    await expect.poll(async () => (await text(a!.page)) === (await text(b!.page))).toBe(true);
    await a.page.getByLabel('글씨체', { exact: true }).selectOption('Consolas'); await a.page.getByLabel('글자 크기', { exact: true }).selectOption('20');
    await a.page.getByRole('button', { name: '설정', exact: true }).click(); await a.page.getByRole('button', { name: '다크 모드', exact: true }).click();
    await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    await a.page.screenshot({ path: join(root, 'artifacts/settings-dark.png') });
    await a.page.getByRole('button', { name: '라이트 모드', exact: true }).click();
    await a.page.getByRole('button', { name: '공동 메모', exact: true }).click();
    await a.page.screenshot({ path: join(root, 'artifacts/note-light.png') });
    await a.page.getByRole('button', { name: '클립보드', exact: true }).click(); await b.page.getByRole('button', { name: '클립보드', exact: true }).click();
    await a.page.getByLabel('보낼 텍스트').fill('npm install\nhttps://example.com');
    await a.page.getByRole('button', { name: '텍스트 보내기' }).click();
    await expect(b.page.getByTitle('클릭하여 복사')).toHaveText('npm install\nhttps://example.com');
    await b.page.getByRole('button', { name: '항목 고정', exact: true }).click();
    await b.page.getByRole('button', { name: '복사', exact: true }).click();
    expect(await b.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('npm install\nhttps://example.com');
    await b.page.getByRole('button', { name: '기기 관리', exact: true }).click();
    await b.page.getByLabel('기기 이름', { exact: true }).fill('LAPTOP-E2E'); await b.page.getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(async () => (await a!.page.evaluate(() => window.desktop.state())).devices.some(d => d.name === 'LAPTOP-E2E')).toBe(true);
    const savedText = await b.page.evaluate(async () => window.desktop.document());
    await b.app.close(); b = undefined;
    await expect.poll(async () => (await a!.page.evaluate(() => window.desktop.state())).devices.find(d => d.name === 'LAPTOP-E2E')?.online).toBe(false);
    b = await launch(profileB);
    await expect.poll(async () => (await b!.page.evaluate(() => window.desktop.state())).connection, { timeout: 15000 }).toBe('connected');
    expect((await a.page.evaluate(() => window.desktop.state())).requests).toHaveLength(0);
    expect((await b.page.evaluate(() => window.desktop.state())).device.name).toBe('LAPTOP-E2E');
    expect((await b.page.evaluate(() => window.desktop.state())).clips[0].pinned).toBe(true);
    expect((await b.page.evaluate(() => window.desktop.document())).length).toBeGreaterThanOrEqual(savedText.length);
    expect(errors).toEqual([]);
  } finally { await b?.app.close(); await a?.app.close(); rmSync(profileA, { recursive: true, force: true }); rmSync(profileB, { recursive: true, force: true }); }
});
