import { ElectronApplication, expect, Page, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminPost, Harness } from './helpers';

// Phase 3 acceptance: mint a token in the UI, one click, and Claude Desktop's
// config + the Keychain are set up so `sieve mcp-launch` lists Sieve's tools.
//
// Isolation: a throwaway keychain file and a temp Claude config. The user's
// login keychain and real Claude Desktop config are never touched; the
// keychain search list is restored afterwards.
test.skip(process.platform !== 'darwin', 'Keychain integration is macOS-only so far');

const h = new Harness(39836, 39837);
const claudeDir = join(h.userData, 'claude-config');
const claudeConfig = join(claudeDir, 'claude_desktop_config.json');
const keychain = join(h.userData, 'sieve-e2e.keychain-db');
const ORIGINAL = { theme: 'dark', mcpServers: { other: { command: '/usr/bin/true', args: ['x'] } } };
let searchList = '';
let app: ElectronApplication;
let page: Page;

const sec = (...args: string[]): string => execFileSync('/usr/bin/security', args).toString();

test.describe.serial('connect to Claude Desktop (Phase 3)', () => {
  test.beforeAll(async () => {
    searchList = sec('list-keychains', '-d', 'user');
    sec('create-keychain', '-p', 'e2e', keychain);
    sec('unlock-keychain', '-p', 'e2e', keychain);
    // Make the throwaway keychain searchable so `mcp-launch` (which searches
    // the default list) can read the token, exactly as with the login one.
    const current = searchList.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    sec('list-keychains', '-d', 'user', '-s', ...current.filter((k) => k !== keychain), keychain);

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(claudeConfig, JSON.stringify(ORIGINAL, null, 2));

    app = await h.launch({
      SIEVE_DESKTOP_TEST_HOOKS: '1',
      SIEVE_DESKTOP_CLAUDE_CONFIG: claudeConfig,
      SIEVE_DESKTOP_TEST_KEYCHAIN: keychain,
    });
    page = await h.adminWindow(app);
    await h.setupOperator(page);
  });

  test.afterAll(async () => {
    await app?.close();
    const original = searchList.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    try { sec('list-keychains', '-d', 'user', '-s', ...original); } catch { /* best effort */ }
    try { sec('delete-keychain', keychain); } catch { /* already gone */ }
    rmSync(h.userData, { recursive: true, force: true });
  });

  test('tokens page: one click stores the token and registers Sieve', async () => {
    let r = await adminPost(page, '/iam/roles', { name: 'claude' });
    expect(r.status).toBe(200);
    await page.goto(`${h.admin}/tokens`);
    await page.fill('form[action="/tokens/create"] input[name="name"]', 'claude-desktop');
    await page.locator('form[action="/tokens/create"] input[name="role_id"]').first().check();
    await Promise.all([page.waitForNavigation(), page.locator('form[action="/tokens/create"] button[type="submit"]').click()]);
    const token = (await page.locator('#token-value').textContent())!.trim();
    expect(token).toMatch(/^sieve_tok_[0-9a-f]{64}$/);

    const btn = page.locator('#connect-claude-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('#connect-claude-status')).toContainText('Connected');

    // Claude config: Sieve added, everything else preserved, backup kept.
    const cfg = JSON.parse(readFileSync(claudeConfig, 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toEqual(ORIGINAL.mcpServers.other);
    expect(cfg.mcpServers.sieve.command).toMatch(/resources\/bin\/sieve$/);
    expect(cfg.mcpServers.sieve.args).toEqual([
      'mcp-launch', '--keychain', 'sieve-claude-desktop', '--url', `http://127.0.0.1:${h.apiPort}/mcp`,
    ]);
    expect(JSON.stringify(cfg)).not.toContain(token); // the token is never in the config
    expect(JSON.parse(readFileSync(claudeConfig + '.before-sieve', 'utf8'))).toEqual(ORIGINAL);

    // Keychain holds the token.
    expect(sec('find-generic-password', '-s', 'sieve-claude-desktop', '-w', keychain).trim()).toBe(token);

    // Run exactly what Claude Desktop will run and speak MCP to it.
    const bridge = spawn(cfg.mcpServers.sieve.command, cfg.mcpServers.sieve.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buf = '';
    bridge.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    let stderr = '';
    bridge.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await expect.poll(() => lines.length, { timeout: 10_000, message: stderr }).toBe(2);
    bridge.stdin.end();
    const init = JSON.parse(lines[0]);
    const list = JSON.parse(lines[1]);
    expect(init.error).toBeUndefined();
    expect(list.error).toBeUndefined();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('list_connections');
  });

  test('the bridge refuses calls from any page but the tokens page', async () => {
    await page.goto(`${h.admin}/connections`);
    const res = await page.evaluate(() =>
      (window as any).sieveDesktop.connectClaude('sieve_tok_' + 'a'.repeat(64)));
    expect(res).toEqual({ ok: false, message: 'Not allowed from this page.' });
    await page.goto(`${h.admin}/tokens`);
    const bad = await page.evaluate(() => (window as any).sieveDesktop.connectClaude('not-a-token'));
    expect(bad.ok).toBe(false);
  });

  test('an unreadable Claude config is left untouched', async () => {
    writeFileSync(claudeConfig, '{ this is not json');
    await page.goto(`${h.admin}/tokens`);
    const res = await page.evaluate(() =>
      (window as any).sieveDesktop.connectClaude('sieve_tok_' + 'b'.repeat(64)));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not valid JSON');
    expect(readFileSync(claudeConfig, 'utf8')).toBe('{ this is not json');
    expect(existsSync(claudeConfig + '.sieve-tmp')).toBe(false);
  });
});
