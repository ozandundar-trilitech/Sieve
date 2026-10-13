import { app, BrowserWindow, session, shell, Session } from 'electron';
import { join } from 'node:path';
import { ADMIN_ORIGIN, HOST, OAUTH_HOSTS, WEB_PORT } from './config';
import { isPinned } from './certs';

export const PARTITION = 'persist:sieve-admin';

/** Installs the pinned-cert verifier on the admin session. Must be re-run
 *  after Electron's network service restarts: the verifier lives in the
 *  network context and is lost when that process is recreated. */
export function installCertPinning(): void {
  session.fromPartition(PARTITION).setCertificateVerifyProc((req, callback) => {
    if (req.hostname === HOST) {
      // Accept only the pinned cert. Port is checked at navigation time;
      // nothing else listens on loopback with this cert.
      callback(isPinned(req.certificate.data) ? 0 : -2);
      return;
    }
    callback(-3); // use Chromium's normal verification result
  });
}

/** Fallback for navigations that still reach Chromium's default check (e.g.
 *  in the window between a network-service restart and re-installation):
 *  accept the admin origin only when the cert is the pinned one. */
export function handleCertificateError(
  event: Electron.Event, url: string, certificate: Electron.Certificate, callback: (ok: boolean) => void,
): void {
  try {
    const u = new URL(url);
    if (isAdminURL(u) && isPinned(certificate.data)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {
    /* fall through */
  }
  callback(false);
}

/**
 * The admin session: one persistent partition shared by the window and the
 * notification stream, so both carry the same operator cookie.
 * Its certificate verifier trusts the local server's own cert for the admin
 * origin and defers to Chromium for every other host.
 */
export function adminSession(): Session {
  const ses = session.fromPartition(PARTITION);
  if (!(ses as Session & { __sieveConfigured?: boolean }).__sieveConfigured) {
    (ses as Session & { __sieveConfigured?: boolean }).__sieveConfigured = true;

    installCertPinning();

    // Google refuses sign-in from browsers that identify as embedded
    // (Electron). OAuth must run in this window because the server binds
    // each OAuth flow to the operator session that started it, which the
    // system browser does not have. Present the plain Chrome user agent.
    ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?sieve-desktop\/\S+/, ''));

    // The admin UI never needs camera, mic, location, etc.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return ses;
}

function isAdminURL(u: URL): boolean {
  return u.protocol === 'https:' && u.hostname === HOST && u.port === String(WEB_PORT);
}

function allowedInWindow(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return true; // our own status page
    if (isAdminURL(u)) return true;
    return u.protocol === 'https:' && OAUTH_HOSTS.has(u.hostname) ||
      // Provider sub-hosts on the consent path (e.g. *.slack.com workspace pages).
      (u.protocol === 'https:' && [...OAUTH_HOSTS].some((h) => u.hostname.endsWith('.' + h)));
  } catch {
    return false;
  }
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Sieve',
    backgroundColor: '#0e0e0d',
    webPreferences: {
      session: adminSession(),
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Links that open new windows (docs, provider consoles) go to the system
  // browser. Never spawn a second Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // In-window navigation is limited to the admin UI and OAuth consent hosts.
  // Anything else opens in the system browser instead.
  const guard = (event: Electron.Event, url: string) => {
    if (allowedInWindow(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);

  win.once('ready-to-show', () => win.show());
  return win;
}

export function statusPage(): string {
  return join(app.getAppPath(), 'static', 'status.html');
}

export function showStatus(win: BrowserWindow, state: string, message = ''): void {
  void win.loadFile(statusPage(), { query: { state, message } });
}

export function showAdmin(win: BrowserWindow, path = '/'): void {
  void win.loadURL(ADMIN_ORIGIN + path);
}
