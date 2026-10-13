import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import { SidecarState } from './sidecar';

export interface TrayActions {
  open(path?: string): void;
  restart(): void;
  showLogs(): void;
  quit(): void;
  notifyBlocked(): boolean;
  setNotifyBlocked(on: boolean): void;
}

function statusLabel(s: SidecarState): string {
  switch (s.kind) {
    case 'running':
      return 'Sieve is running';
    case 'starting':
      return 'Starting…';
    case 'crashed':
      return `Restarting in ${Math.ceil(s.retryInMs / 1000)}s…`;
    case 'failed':
      return 'Sieve is not running';
    case 'stopped':
      return 'Stopped';
  }
}

export class SieveTray {
  private tray: Tray;
  private state: SidecarState = { kind: 'stopped' };
  private pending = 0;

  constructor(private readonly actions: TrayActions) {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Sieve');
    // Left-click on Windows opens the window; macOS shows the menu.
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') this.actions.open();
    });
    this.render();
  }

  setState(s: SidecarState): void {
    this.state = s;
    this.render();
  }

  /** Pending-approval count, driven by the event stream. */
  setPending(n: number): void {
    this.pending = n;
    this.render();
  }

  private render(): void {
    const running = this.state.kind === 'running';
    const login = app.getLoginItemSettings();
    if (process.platform === 'darwin') this.tray.setTitle(this.pending > 0 ? String(this.pending) : '');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLabel(this.state), enabled: false },
        { type: 'separator' },
        { label: 'Open Sieve', click: () => this.actions.open() },
        {
          label: this.pending > 0 ? `Approvals (${this.pending})` : 'Approvals',
          enabled: running,
          click: () => this.actions.open('/approvals'),
        },
        { type: 'separator' },
        {
          label: 'Notify When Requests Are Blocked',
          type: 'checkbox',
          checked: this.actions.notifyBlocked(),
          click: (item) => {
            this.actions.setNotifyBlocked(item.checked);
            this.render();
          },
        },
        {
          label: 'Start at Login',
          type: 'checkbox',
          checked: login.openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
            this.render();
          },
        },
        { label: 'Restart Server', click: () => this.actions.restart() },
        { label: 'Show Server Log', click: () => this.actions.showLogs() },
        { type: 'separator' },
        { label: 'Quit Sieve', click: () => this.actions.quit() },
      ]),
    );
  }
}
