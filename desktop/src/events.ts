import { EventEmitter } from 'node:events';
import { ADMIN_ORIGIN } from './config';
import { Notifier } from './notifier';
import { adminSession } from './window';

/** One server-sent event, as written by internal/web/events.go. */
interface ServerEvent {
  type: string;
  time: string;
  data: Record<string, unknown>;
}

export interface EventClientHooks {
  notifier: Notifier;
  /** Open the admin window at a path. */
  open(path: string): void;
  /** Whether to notify on blocked agent requests. */
  notifyBlocked(): boolean;
}

/** An approval as listed by GET /approvals/pending.json. */
interface PendingApproval {
  id: string;
  token_name: string;
  operation: string;
  connection_id: string;
  param_keys: string[];
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribes to GET /events with the admin window's operator session and turns
 * events into OS notifications. Emits 'pending' (number) for the tray badge
 * and 'connected' (boolean).
 *
 * It needs a logged-in operator session. Before login (or after the session
 * ends) the endpoint redirects to /login; the client then waits for kick(),
 * which main.ts calls whenever the window lands on an admin page.
 */
export class EventClient extends EventEmitter {
  private abort: AbortController | null = null;
  private running = false;
  private csrf = '';
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private waitingForLogin = false;
  /** Approval ids already notified, so catch-up never repeats a notice. */
  private notified = new Set<string>();

  constructor(private readonly hooks: EventClientHooks) {
    super();
  }

  /** Start (or keep) streaming. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.emit('connected', false);
  }

  /** The window is on the login page: the operator session is gone or
   *  ending. Drop the stream now rather than at the server's next session
   *  check, and wait for kick() after the next login. */
  pause(): void {
    this.emit('debug', 'pause');
    this.stop();
    this.waitingForLogin = true;
  }

  /** Called after a navigation to an admin page: a login may have happened. */
  kick(): void {
    this.emit('debug', `kick (waitingForLogin=${this.waitingForLogin})`);
    if (!this.waitingForLogin) return;
    this.waitingForLogin = false;
    this.stop();
    this.start();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const outcome = await this.connectOnce();
      if (!this.running) return;
      if (outcome === 'needs-login') {
        // Nothing to do until the operator logs in; kick() restarts us.
        this.waitingForLogin = true;
        this.running = false;
        this.emit('connected', false);
        return;
      }
      await new Promise<void>((resolve) => {
        this.retryTimer = setTimeout(resolve, this.retryMs);
      });
      this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    }
  }

  private async connectOnce(): Promise<'needs-login' | 'retry'> {
    this.abort = new AbortController();
    let res: Response;
    try {
      // Redirects are followed: Electron's session.fetch throws on a
      // redirect in 'manual' mode rather than returning the 3xx. Without a
      // session the server redirects to /login, which arrives here as a
      // 200 text/html page and is treated as "needs login" below.
      res = await adminSession().fetch(`${ADMIN_ORIGIN}/events`, {
        signal: this.abort.signal,
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
    } catch (e) {
      this.emit('debug', `connect error: ${(e as Error).message}`);
      return 'retry'; // server restarting, etc.
    }
    const type = res.headers.get('content-type') ?? '';
    this.emit('debug', `connect: ${res.status} ${type}`);
    if (res.status !== 200 || !type.startsWith('text/event-stream')) {
      void res.body?.cancel();
      // Landed on /login (no or expired session) or 401: wait for a login.
      return res.status === 503 || res.status >= 500 ? 'retry' : 'needs-login';
    }
    this.retryMs = RECONNECT_MIN_MS;
    this.emit('connected', true);

    const ended = await this.read(res.body!);
    this.emit('connected', false);
    return ended === 'session_ended' ? 'needs-login' : 'retry';
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<'eof' | 'session_ended'> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'eof';
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (!data) continue; // ": ping" heartbeat
          let ev: ServerEvent;
          try {
            ev = JSON.parse(data) as ServerEvent;
          } catch {
            continue;
          }
          this.emit('debug', `event: ${ev.type}`);
          if (ev.type === 'session_ended') return 'session_ended';
          this.handle(ev);
        }
      }
    } catch {
      return 'eof';
    } finally {
      reader.releaseLock();
    }
  }

  private handle(ev: ServerEvent): void {
    const d = ev.data;
    const str = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
    switch (ev.type) {
      case 'hello':
        this.csrf = str('csrf_token');
        this.emit('pending', Number(d.pending_approvals) || 0);
        // Catch up on approvals requested while we were not connected
        // (app just started, server restarted, operator just logged in).
        void this.refreshPending(true);
        return;

      case 'approval.pending':
        this.showApproval({
          id: str('id'),
          token_name: str('token_name'),
          operation: str('operation'),
          connection_id: str('connection_id'),
          param_keys: Array.isArray(d.param_keys) ? (d.param_keys as string[]) : [],
        });
        void this.refreshPending();
        return;

      case 'approval.resolved':
        this.notified.delete(str('id'));
        this.hooks.notifier.close(`approval:${str('id')}`);
        void this.refreshPending();
        return;

      case 'connection.reauth_required': {
        const name = str('display_name') || str('connection_id');
        this.hooks.notifier.show({
          key: `reauth:${str('connection_id')}`,
          title: `${name} needs you to sign in again`,
          body: 'Agents cannot use this connection until it is reconnected.',
          onClick: () => this.hooks.open('/connections'),
        });
        return;
      }

      case 'policy.denied': {
        if (!this.hooks.notifyBlocked()) return;
        const who = str('token_name') || 'An agent';
        const n = Number(d.count) || 1;
        this.hooks.notifier.show({
          key: `denied:${str('token_id')}:${str('connection_id')}:${str('operation')}`,
          title: `Blocked: ${who}`,
          body:
            `${str('operation')} on ${str('connection_id')}` +
            (n > 1 ? ` (${n} attempts)` : '') +
            (str('reason') ? ` — ${str('reason')}` : ''),
          onClick: () => this.hooks.open('/audit'),
        });
        return;
      }
    }
  }

  private showApproval(a: PendingApproval): void {
    if (!a.id || this.notified.has(a.id)) return;
    this.notified.add(a.id);
    const who = a.token_name || 'An agent';
    const keys = a.param_keys ?? [];
    this.hooks.notifier.show({
      key: `approval:${a.id}`,
      title: `${who} needs approval`,
      body: `${a.operation} on ${a.connection_id}` + (keys.length ? ` (${keys.join(', ')})` : ''),
      actions: ['Approve', 'Reject'],
      onAction: (i) => void this.resolve(a.id, i === 0 ? 'approve' : 'reject'),
      onClick: () => this.hooks.open('/approvals'),
    });
  }

  /** POSTs approve/reject with the operator session + CSRF token. */
  async resolve(id: string, action: 'approve' | 'reject'): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(id) || !this.csrf) return false;
    try {
      // The handler answers 303 → /approvals; follow it and require that we
      // ended up there (a lost session would land on /login instead).
      const res = await adminSession().fetch(`${ADMIN_ORIGIN}/approvals/${id}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': this.csrf },
      });
      void res.body?.cancel();
      const ok = res.ok && new URL(res.url).pathname === '/approvals';
      if (!ok) this.hooks.open('/approvals'); // let the operator see why
      return ok;
    } catch {
      this.hooks.open('/approvals');
      return false;
    }
  }

  private async refreshPending(notifyMissed = false): Promise<void> {
    try {
      const res = await adminSession().fetch(`${ADMIN_ORIGIN}/approvals/pending.json`, {
        credentials: 'include',
      });
      if (res.status !== 200 || !(res.headers.get('content-type') ?? '').startsWith('application/json')) return;
      const body = (await res.json()) as { count?: number; approvals?: PendingApproval[] };
      this.emit('pending', Number(body.count) || 0);
      if (notifyMissed) for (const a of body.approvals ?? []) this.showApproval(a);
    } catch {
      /* the next event retries */
    }
  }
}
