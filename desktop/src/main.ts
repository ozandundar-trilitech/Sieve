import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeError, claudeRunning, registerWithClaude, relaunchClaude, storeToken, TOKEN_RE } from './claude';
import { ADMIN_ORIGIN, logPath } from './config';
import { EventClient } from './events';
import { installAppMenu, wireNavigationGestures } from './menu';
import { NativeNotifier, Notifier, RecordingNotifier } from './notifier';
import { loadOrCreatePassphrase } from './passphrase';
import { loadPrefs, savePrefs } from './prefs';
import { Sidecar, SidecarState } from './sidecar';
import { SieveTray } from './tray';
import { adminSession, createWindow, handleCertificateError, installCertPinning, showAdmin, showStatus } from './window';

// Tests and side-by-side development can isolate all state.
if (process.env.SIEVE_DESKTOP_USER_DATA && !app.isPackaged) {
  app.setPath('userData', process.env.SIEVE_DESKTOP_USER_DATA);
}
app.setName('Sieve');

// One app per user: a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;
  let tray: SieveTray | null = null;
  let quitting = false;
  const sidecar = new Sidecar(loadOrCreatePassphrase);
  const prefs = loadPrefs();

  // Test hooks: unpackaged builds only, explicitly opted into. They replace
  // OS notifications with a recorder the Playwright suite can inspect.
  const testHooks = !app.isPackaged && process.env.SIEVE_DESKTOP_TEST_HOOKS === '1';
  // logs/desktop.log: the shell's own diagnostics (notification stream state,
  // notification shown/failed/clicked). Event types and ids only, never
  // request content.
  const desktopLog = (line: string): void => {
    try {
      const p = join(app.getPath('userData'), 'logs', 'desktop.log');
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* diagnostics are best-effort */
    }
  };
  const notifier: Notifier = testHooks ? new RecordingNotifier() : new NativeNotifier(desktopLog);
  const debugLog: string[] = [];
  if (testHooks) (globalThis as Record<string, unknown>).__sieveTest = { notifier, debugLog };

  const events = new EventClient({
    notifier,
    open: (path) => openWindow(path),
    notifyBlocked: () => prefs.notifyBlocked,
  });
  events.on('debug', (line: string) => {
    desktopLog(`events: ${line}`);
    if (testHooks) debugLog.push(line);
  });

  const launchedHidden =
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

  function render(state: SidecarState, path?: string): void {
    if (!win || win.isDestroyed()) return;
    if (state.kind === 'running') {
      const current = win.webContents.getURL();
      // Keep the operator where they are across tray clicks; only navigate
      // when coming from the status page or when asked for a specific page.
      if (path || !current.startsWith(ADMIN_ORIGIN)) showAdmin(win, path ?? '/');
      return;
    }
    const message = state.kind === 'failed' || state.kind === 'crashed' ? state.message : '';
    showStatus(win, state.kind, message);
  }

  function openWindow(path?: string): void {
    if (!win || win.isDestroyed()) {
      win = createWindow();
      wireNavigationGestures(win);
      // Landing on an admin page may mean the operator just logged in:
      // (re)connect the notification stream.
      win.webContents.on('did-navigate', (_e, url) => {
        if (!url.startsWith(ADMIN_ORIGIN)) return;
        const path = new URL(url).pathname;
        if (path === '/login' || path === '/setup') events.pause();
        else events.kick();
      });
      win.on('close', (e) => {
        // Closing the window hides it; the server keeps running in the tray.
        if (!quitting) {
          e.preventDefault();
          win?.hide();
          if (process.platform === 'darwin') app.dock?.hide();
        }
      });
      render(sidecar.current, path);
    } else if (path) {
      render(sidecar.current, path);
    }
    if (process.platform === 'darwin') void app.dock?.show();
    win.show();
    win.focus();
  }

  // Only our own status page (file://) may restart the server or open the
  // log; remote admin pages get the bridge object but these calls refuse.
  function fromStatusPage(e: IpcMainInvokeEvent): boolean {
    return e.senderFrame?.url.startsWith('file://') ?? false;
  }
  ipcMain.handle('sieve:restart', async (e) => {
    if (fromStatusPage(e)) await sidecar.restart();
  });
  ipcMain.handle('sieve:show-logs', async (e) => {
    if (fromStatusPage(e)) await shell.openPath(logPath());
  });

  // Connect to Claude Desktop: only from the admin tokens page (where the
  // one-time token is displayed), only with a well-formed token, and only
  // after the user confirms in a native dialog the page cannot script.
  ipcMain.handle('sieve:connect-claude', async (e, token: unknown) => {
    const url = e.senderFrame?.url ?? '';
    if (!url.startsWith(ADMIN_ORIGIN + '/tokens')) return { ok: false, message: 'Not allowed from this page.' };
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, message: 'That is not a Sieve token.' };

    const running = await claudeRunning();
    if (!testHooks) {
      const opts: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['Connect', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Connect this token to Claude Desktop?',
        detail:
          'Sieve will save the token in your Keychain and add Sieve to Claude Desktop\'s list of tools. ' +
          'Claude will be able to do exactly what this token\'s roles allow.' +
          (running ? '\n\nClaude Desktop is open and will restart to pick up the change.' : ''),
      };
      const choice = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (choice.response !== 0) return { ok: false, message: 'Cancelled.' };
    }
    try {
      await storeToken(token);
      registerWithClaude();
    } catch (err) {
      const message = err instanceof ClaudeError ? err.message : `Something went wrong: ${(err as Error).message}`;
      return { ok: false, message };
    }
    if (running && !testHooks) {
      await relaunchClaude();
      return { ok: true, message: 'Connected. Claude Desktop restarted with Sieve\'s tools.' };
    }
    return { ok: true, message: 'Connected. Open Claude Desktop to use Sieve\'s tools.' };
  });

  app.on('second-instance', () => openWindow());
  app.on('activate', () => openWindow()); // macOS dock click

  // The tray keeps the app alive with no windows.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    events.stop();
    void sidecar.stop().finally(() => app.quit());
  });

  // Electron restarts its network service if it dies, and the restarted
  // service has lost our certificate verifier. Re-install it, then reload a
  // window that failed in between.
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'Utility' || !/network/i.test(details.serviceName ?? details.name ?? '')) return;
    setTimeout(() => {
      installCertPinning();
      if (win && !win.isDestroyed() && sidecar.current.kind === 'running') {
        const url = win.webContents.getURL();
        if (!url.startsWith(ADMIN_ORIGIN)) render(sidecar.current);
      }
    }, 250);
  });
  app.on('certificate-error', (event, _wc, url, _err, certificate, callback) =>
    handleCertificateError(event, url, certificate, callback));

  app.whenReady().then(() => {
    adminSession(); // install cert pinning before anything loads
    installAppMenu(() => openWindow('/'));

    tray = new SieveTray({
      open: (path) => openWindow(path),
      restart: () => void sidecar.restart(),
      showLogs: () => void shell.openPath(logPath()),
      quit: () => app.quit(),
      notifyBlocked: () => prefs.notifyBlocked,
      setNotifyBlocked: (on) => {
        prefs.notifyBlocked = on;
        savePrefs(prefs);
      },
    });

    events.on('pending', (n: number) => tray?.setPending(n));
    events.on('connected', (on: boolean) => {
      if (!on) tray?.setPending(0);
    });

    sidecar.on('state', (s: SidecarState) => {
      tray?.setState(s);
      render(s);
      if (s.kind === 'running') events.start();
      else events.stop();
    });

    if (launchedHidden) {
      if (process.platform === 'darwin') app.dock?.hide();
    } else {
      openWindow();
    }
    void sidecar.start();
  }).catch((err: Error) => {
    dialog.showErrorBox('Sieve could not start', err.message);
    app.exit(1);
  });
}
