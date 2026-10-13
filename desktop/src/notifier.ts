import { Notification } from 'electron';

/** A notification the app wants to show. `key` dedupes and lets it be closed. */
export interface SieveNotice {
  key: string;
  title: string;
  body: string;
  /** Button labels (macOS shows them; elsewhere only the click works). */
  actions?: string[];
  onAction?: (index: number) => void;
  onClick?: () => void;
}

export interface Notifier {
  show(n: SieveNotice): void;
  close(key: string): void;
}

/** Native OS notifications via Electron. */
export class NativeNotifier implements Notifier {
  // Electron garbage-collects notifications that aren't referenced, which
  // silently drops their click/action handlers. Keep them until closed.
  private live = new Map<string, Notification>();

  /** log receives one-line diagnostics (notice key + outcome, never body). */
  constructor(private readonly log: (line: string) => void = () => {}) {}

  show(n: SieveNotice): void {
    if (!Notification.isSupported()) {
      this.log(`notification unsupported: ${n.key}`);
      return;
    }
    this.close(n.key);
    const note = new Notification({
      title: n.title,
      body: n.body,
      silent: false,
      actions: (n.actions ?? []).map((text) => ({ type: 'button' as const, text })),
      // On macOS an explicit close button keeps the action buttons visible
      // instead of hiding them under a single "Options" menu.
      closeButtonText: n.actions?.length ? 'Later' : undefined,
    });
    note.on('show', () => this.log(`notification shown: ${n.key}`));
    note.on('failed', (_e, err) => this.log(`notification FAILED: ${n.key}: ${err}`));
    note.on('action', (_e, index) => {
      this.log(`notification action ${index}: ${n.key}`);
      this.live.delete(n.key);
      n.onAction?.(index);
    });
    note.on('click', () => {
      this.log(`notification clicked: ${n.key}`);
      this.live.delete(n.key);
      n.onClick?.();
    });
    note.on('close', () => this.live.delete(n.key));
    this.live.set(n.key, note);
    note.show();
  }

  close(key: string): void {
    this.live.get(key)?.close();
    this.live.delete(key);
  }
}

/**
 * Test-only notifier: records notices so the Playwright suite can assert on
 * them and press their buttons. Enabled only for unpackaged builds with
 * SIEVE_DESKTOP_TEST_HOOKS=1.
 */
export class RecordingNotifier implements Notifier {
  readonly shown: SieveNotice[] = [];
  readonly closed: string[] = [];
  show(n: SieveNotice): void {
    this.shown.push(n);
  }
  close(key: string): void {
    this.closed.push(key);
  }
  press(key: string, index: number): boolean {
    const n = [...this.shown].reverse().find((x) => x.key === key);
    if (!n?.onAction) return false;
    n.onAction(index);
    return true;
  }
}
