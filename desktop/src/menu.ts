import { app, BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';

/**
 * The app menu. The window has no browser toolbar, so navigation lives here:
 * Go → Back (Cmd+[), Forward (Cmd+]), Home (Shift+Cmd+H), with the same keys
 * on Windows/Linux using Ctrl / Alt+Left / Alt+Right. Edit keeps copy/paste
 * working in forms; View keeps reload and zoom.
 */
export function installAppMenu(goHome: () => void): void {
  const win = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const nav = () => win()?.webContents.navigationHistory;
  const mac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Back',
          accelerator: mac ? 'Cmd+[' : 'Alt+Left',
          click: () => { if (nav()?.canGoBack()) nav()!.goBack(); },
        },
        {
          label: 'Forward',
          accelerator: mac ? 'Cmd+]' : 'Alt+Right',
          click: () => { if (nav()?.canGoForward()) nav()!.goForward(); },
        },
        { type: 'separator' },
        { label: 'Home', accelerator: 'Shift+CmdOrCtrl+H', click: goHome },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Mouse back/forward buttons (Windows/Linux) and trackpad swipes (macOS). */
export function wireNavigationGestures(w: BrowserWindow): void {
  const h = w.webContents.navigationHistory;
  w.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && h.canGoBack()) h.goBack();
    if (cmd === 'browser-forward' && h.canGoForward()) h.goForward();
  });
  w.on('swipe', (_e, dir) => {
    if (dir === 'right' && h.canGoBack()) h.goBack();
    if (dir === 'left' && h.canGoForward()) h.goForward();
  });
}
