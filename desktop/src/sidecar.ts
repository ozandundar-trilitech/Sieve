import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, WriteStream } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { dirname } from 'node:path';
import { API_PORT, dataDir, dbPath, HOST, logPath, sidecarPath, WEB_PORT } from './config';
import { pinnedFingerprint } from './certs';

export type SidecarState =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'crashed'; message: string; retryInMs: number }
  | { kind: 'failed'; message: string };

const READY_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Supervises the bundled Go server.
 *
 * Events: 'state' (SidecarState), 'log' (string line).
 */
export class Sidecar extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SidecarState = { kind: 'stopped' };
  private stopping = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private log: WriteStream | null = null;
  private lastStderr: string[] = [];

  constructor(private readonly passphrase: () => Buffer) {
    super();
  }

  get current(): SidecarState {
    return this.state;
  }

  private setState(s: SidecarState): void {
    this.state = s;
    this.emit('state', s);
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.setState({ kind: 'starting' });

    const busy = await firstBusyPort([WEB_PORT, API_PORT]);
    if (busy !== null) {
      this.setState({
        kind: 'failed',
        message:
          `Port ${busy} is already in use. Another copy of Sieve (for example a Docker ` +
          `or terminal install) may be running. Stop it and choose Restart.`,
      });
      return;
    }

    const bin = sidecarPath();
    if (!existsSync(bin)) {
      this.setState({ kind: 'failed', message: `Sieve server binary not found at ${bin}.` });
      return;
    }

    let pp: Buffer;
    try {
      pp = this.passphrase();
    } catch (e) {
      this.setState({ kind: 'failed', message: (e as Error).message });
      return;
    }

    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    this.openLog();

    // Strip variables that would override or leak the passphrase handoff:
    // SIEVE_PASSPHRASE_FILE takes precedence over the fd in the server.
    const env: NodeJS.ProcessEnv = { ...process.env, SIEVE_PASSPHRASE_FD: '3' };
    delete env.SIEVE_PASSPHRASE_FILE;
    delete env.SIEVE_OPERATOR_CREDENTIAL_FILE;

    const args = [
      '--init-if-needed',
      '--db', dbPath(),
      '--web', `${HOST}:${WEB_PORT}`,
      '--api', `${HOST}:${API_PORT}`,
    ];
    this.lastStderr = [];
    const child = spawn(bin, args, {
      // cwd = data dir so the server's cwd-relative lookups (e.g. the
      // *client_secret*.json auto-discovery) never see the user's files.
      cwd: dataDir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    // fd 3: write the passphrase and close. The server reads to EOF.
    const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
    fd3?.on('error', () => {}); // EPIPE if the child dies first; reported via exit
    fd3?.end(pp);
    pp.fill(0);

    child.stdout?.on('data', (b: Buffer) => this.write(b));
    child.stderr?.on('data', (b: Buffer) => {
      this.write(b);
      for (const line of b.toString('utf8').split('\n').filter(Boolean)) {
        this.lastStderr.push(line);
        if (this.lastStderr.length > 20) this.lastStderr.shift();
      }
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', (err) => {
      this.write(Buffer.from(`spawn error: ${err.message}\n`));
    });

    try {
      await waitReady(() => this.child === child && child.exitCode === null);
    } catch (e) {
      if (this.child === child && child.exitCode === null) {
        this.write(Buffer.from(`readiness: ${(e as Error).message}\n`));
        child.kill('SIGKILL');
      }
      return; // onExit reports and schedules a restart
    }
    if (this.child !== child) return;
    this.failures = 0;
    this.setState({ kind: 'running' });
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.write(Buffer.from(`sieve exited (code=${code} signal=${signal})\n`));
    if (this.stopping) {
      this.setState({ kind: 'stopped' });
      return;
    }
    const message = this.exitMessage();
    // A wrong key or a corrupt store will not fix itself; don't loop on it.
    if (/wrong passphrase|legacy|incompatible/i.test(message)) {
      this.setState({ kind: 'failed', message });
      return;
    }
    this.failures++;
    const retryInMs = Math.min(1000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    this.setState({ kind: 'crashed', message, retryInMs });
    this.restartTimer = setTimeout(() => void this.start(), retryInMs);
  }

  private exitMessage(): string {
    const fatal = [...this.lastStderr].reverse().find((l) => l.startsWith('sieve: '));
    return fatal ?? this.lastStderr.at(-1) ?? 'The Sieve server stopped unexpectedly.';
  }

  /** Stops the server: SIGTERM, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.setState({ kind: 'stopped' });
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.log?.end();
    this.log = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.failures = 0;
    await this.start();
  }

  private openLog(): void {
    if (this.log) return;
    const p = logPath();
    mkdirSync(dirname(p), { recursive: true });
    try {
      if (statSync(p).size > MAX_LOG_BYTES) renameSync(p, p + '.1');
    } catch {
      /* no log yet */
    }
    this.log = createWriteStream(p, { flags: 'a', mode: 0o600 });
  }

  private write(b: Buffer): void {
    this.log?.write(b);
    this.emit('log', b.toString('utf8'));
  }
}

/** Returns the first port in ports that is already bound on loopback. */
async function firstBusyPort(ports: number[]): Promise<number | null> {
  for (const port of ports) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, HOST);
    });
    if (!free) return port;
  }
  return null;
}

/**
 * Resolves once the admin UI answers over TLS with the pinned certificate.
 * The cert file appears just before the listener starts, so both are polled.
 */
async function waitReady(alive: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('server exited during startup');
    const fp = pinnedFingerprint();
    if (fp && (await probe(fp))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`admin UI did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}

function probe(fingerprint: string): Promise<boolean> {
  // Pin by exact fingerprint rather than passing the cert as `ca`: the
  // server's cert is a CA:FALSE leaf, which Electron's BoringSSL (unlike
  // Node's OpenSSL) refuses as a trust anchor. Chain validation is skipped
  // ONLY because the fingerprint check below is stricter than it.
  return new Promise((resolve) => {
    const req = https.get(
      { host: HOST, port: WEB_PORT, path: '/login', rejectUnauthorized: false, agent: false, timeout: 2000 },
      (res) => {
        const peer = (res.socket as import('node:tls').TLSSocket).getPeerX509Certificate?.();
        res.resume();
        resolve(peer?.fingerprint256 === fingerprint);
      },
    );
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', () => resolve(false));
  });
}
