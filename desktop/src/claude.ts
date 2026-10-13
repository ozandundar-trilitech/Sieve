import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { API_PORT, HOST, sidecarPath } from './config';

/**
 * "Connect to Claude Desktop": store an agent token where `sieve mcp-launch`
 * reads it, and register Sieve in Claude Desktop's MCP config.
 *
 * Claude Desktop only speaks stdio MCP, so its config runs the bundled
 * `sieve mcp-launch`, a stdio→HTTP bridge to the agent port. The token is
 * kept in the macOS Keychain, never in the JSON config.
 */

export const SERVER_NAME = 'sieve';
export const KEYCHAIN_SERVICE = 'sieve-claude-desktop';
export const TOKEN_RE = /^sieve_tok_[0-9a-f]{64}$/;

export class ClaudeError extends Error {}

const devOverride = (name: string): string | undefined =>
  !app.isPackaged ? process.env[name] || undefined : undefined;

/** Claude Desktop's config file for this OS. */
export function claudeConfigPath(): string {
  const override = devOverride('SIEVE_DESKTOP_CLAUDE_CONFIG');
  if (override) return override;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Stores the token in the login Keychain under KEYCHAIN_SERVICE (replacing
 * any previous one). The token goes to `security` over stdin in interactive
 * mode, so it never appears in a process argument list (`ps`).
 */
export function storeToken(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return Promise.reject(new ClaudeError('That is not a Sieve token.'));
  if (process.platform !== 'darwin') {
    return Promise.reject(new ClaudeError('Connecting to Claude Desktop is only supported on macOS so far.'));
  }
  // Tests point this at a throwaway keychain file instead of the login one.
  const keychain = devOverride('SIEVE_DESKTOP_TEST_KEYCHAIN');
  const account = userInfo().username;
  const cmd =
    `add-generic-password -U -a ${quote(account)} -s ${KEYCHAIN_SERVICE} ` +
    `-l "Sieve token for Claude Desktop" -w ${token}` + (keychain ? ` ${quote(keychain)}` : '') + '\n';
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b: Buffer) => (err += b.toString()));
    p.on('error', (e) => reject(new ClaudeError(`Keychain: ${e.message}`)));
    p.on('exit', (code) =>
      code === 0 && !err.trim()
        ? resolve()
        : reject(new ClaudeError(`Could not save the token to the Keychain${err ? `: ${err.trim()}` : ''}.`)),
    );
    p.stdin.end(cmd);
  });
}

function quote(s: string): string {
  return `"${s.replace(/["\\]/g, '\\$&')}"`;
}

/** The mcpServers entry Sieve writes. */
export function serverEntry(): { command: string; args: string[] } {
  return {
    command: sidecarPath(),
    args: ['mcp-launch', '--keychain', KEYCHAIN_SERVICE, '--url', `http://${HOST}:${API_PORT}/mcp`],
  };
}

/**
 * Adds or replaces mcpServers.sieve in Claude Desktop's config, preserving
 * everything else. Refuses to touch a file it cannot parse, keeps a backup
 * of the previous version, and writes atomically.
 */
export function registerWithClaude(): { path: string; backup: string | null } {
  const path = claudeConfigPath();
  let config: Record<string, unknown> = {};
  let backup: string | null = null;
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        config = parsed as Record<string, unknown>;
      } catch {
        throw new ClaudeError(`Claude Desktop's config at ${path} is not valid JSON. Sieve left it unchanged.`);
      }
    }
    backup = `${path}.before-sieve`;
    copyFileSync(path, backup);
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  servers[SERVER_NAME] = serverEntry();
  config.mcpServers = servers;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.sieve-tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return { path, backup };
}

/** Whether Claude Desktop is currently running (macOS). */
export function claudeRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) =>
    execFile('/usr/bin/pgrep', ['-x', 'Claude'], (err) => resolve(!err)),
  );
}

/** Quits and reopens Claude Desktop so it reads the new config (macOS). */
export function relaunchClaude(): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', 'quit app "Claude"'], () => {
      // Give it a moment to exit before reopening.
      setTimeout(() => execFile('/usr/bin/open', ['-a', 'Claude'], () => resolve()), 1500);
    });
  });
}
