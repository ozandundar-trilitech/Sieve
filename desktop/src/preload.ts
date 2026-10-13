import { contextBridge, ipcRenderer } from 'electron';

// The ONLY surface the admin pages and the status page get from the shell.
// The main process re-checks which page is calling before acting, so an admin
// page (remote content) cannot use status-page-only actions.
contextBridge.exposeInMainWorld('sieveDesktop', {
  isDesktop: true,
  restartServer: (): Promise<void> => ipcRenderer.invoke('sieve:restart'),
  showLogs: (): Promise<void> => ipcRenderer.invoke('sieve:show-logs'),
  // Tokens page only (checked in main): store this token for Claude Desktop
  // and register Sieve in its MCP config. Asks the user first.
  connectClaude: (token: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('sieve:connect-claude', token),
});
