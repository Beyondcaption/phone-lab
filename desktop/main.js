'use strict';
// phone-lab Desk: das Dashboard des phone-lab-Servers in einem eigenen Fenster.
// Auf dem Mac mit den iPhones verbindet es sich von selbst mit dem lokalen Server (127.0.0.1:3000, die phone-lab.app im
// Hintergrund), auf den Rechnern der VAs mit der Tailscale-Adresse des Macs. Die App enthält keine Schlüssel.
// Updates kommen über den phone-lab-Server (/desktop/...), der sie aus den GitHub-Releases (Tag desktop-v*) durchreicht:
// Windows installiert selbst (electron-updater), der unsignierte Mac lädt das DMG in den Download-Ordner.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOCAL = 'http://127.0.0.1:3000';
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch { return {}; } };
const writeConfig = c => { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2)); };
let win = null, server = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// Adresse säubern: Schema ergänzen, Pfad und Schrägstrich am Ende weg
function normalise(input) {
  let s = String(input || '').trim(); if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = (/^(127\.|localhost|192\.168\.|10\.)/.test(s) ? 'http://' : 'https://') + s;
  try { const u = new URL(s); return u.origin; } catch { return null; }
}
// Antwortet dort ein phone-lab? GET /login liefert die Anmeldeseite mit dem Namen.
function probe(origin, timeout = 4000) {
  return new Promise(resolve => {
    const lib = origin.startsWith('https') ? https : http;
    const req = lib.get(origin + '/login', { timeout }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 20000) body += c; });
      res.on('end', () => resolve(res.statusCode < 500 && body.includes('phone-lab') ? { ok: true } : { ok: false, error: `answers, but is not phone-lab (HTTP ${res.statusCode})` }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 4 seconds')));
    req.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

function createWindow() {
  const st = readConfig().bounds || {};
  win = new BrowserWindow({
    width: st.width || 1440, height: st.height || 900, x: st.x, y: st.y, minWidth: 380, minHeight: 500,
    backgroundColor: '#0c0d0f', title: 'phone-lab', autoHideMenuBar: process.platform !== 'darwin', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', () => { const c = readConfig(); c.bounds = win.getBounds(); writeConfig(c); });
  // Links zu fremden Seiten im normalen Browser öffnen, im Fenster bleibt nur der phone-lab-Server
  win.webContents.setWindowOpenHandler(({ url }) => { if (!server || !url.startsWith(server)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url.startsWith('file:') || (server && url.startsWith(server))) return; e.preventDefault(); shell.openExternal(url); });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && server && url.startsWith(server)) showConnect(`Could not reach ${server}: ${desc}`); });
}

function showConnect(message) { win.loadFile(path.join(__dirname, 'connect.html'), { query: { msg: message || '', current: server || readConfig().server || '' } }); }
function openServer(origin) { server = origin; win.loadURL(origin + '/'); setTimeout(checkForUpdates, 15000); }

ipcMain.handle('probe', async (e, input) => { const o = normalise(input); return o ? { ...(await probe(o)), origin: o } : { ok: false, error: 'not an address' }; });
ipcMain.handle('connect', async (e, input) => {
  const o = normalise(input); if (!o) return { ok: false, error: 'not an address' };
  const r = await probe(o); if (!r.ok) return r;
  const c = readConfig(); c.server = o; writeConfig(c); openServer(o); return { ok: true };
});
ipcMain.handle('info', async () => ({ version: app.getVersion(), platform: process.platform, local: (await probe(LOCAL, 1500)).ok }));

// ---------- Updates ----------
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return false; };
function getJson(url) {
  return new Promise(resolve => {
    (url.startsWith('https') ? https : http).get(url, { timeout: 8000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } }); })
      .on('error', () => resolve(null)).on('timeout', function () { this.destroy(); });
  });
}
// Lädt in den Download-Ordner ohne Browser: so trägt die Datei kein Quarantäne-Attribut (Gatekeeper fragt nicht nach "beschädigt")
function download(url, file) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const out = fs.createWriteStream(file); res.pipe(out); out.on('finish', () => out.close(() => resolve(file))); out.on('error', reject);
    }).on('error', reject);
  });
}
let checking = false;
async function checkForUpdates(manual) {
  if (!server || checking || !app.isPackaged) { if (manual && !app.isPackaged) dialog.showMessageBox(win, { message: 'Updates only run in the installed app.' }); return; }
  checking = true;
  try {
    const info = await getJson(server + '/desktop/version');
    if (!info || !info.version) { if (manual) dialog.showMessageBox(win, { message: 'No update information on this server.', detail: 'The phone-lab server needs GITHUB_TOKEN in its .env to offer app updates.' }); return; }
    if (!newer(info.version, app.getVersion())) { if (manual) dialog.showMessageBox(win, { message: `phone-lab Desk ${app.getVersion()} is up to date.` }); return; }
    if (process.platform === 'win32') {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.setFeedURL({ provider: 'generic', url: server + '/desktop/' });
      autoUpdater.disableDifferentialDownload = true;      // der Server beantwortet keine Teil-Anfragen
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.once('update-downloaded', () => {
        dialog.showMessageBox(win, { type: 'info', message: `phone-lab Desk ${info.version} is ready`, detail: 'Restart now to install it, or it installs when you quit.', buttons: ['Restart now', 'Later'] })
          .then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); });
      });
      autoUpdater.on('error', e => { if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Update failed', detail: e.message }); });
      await autoUpdater.checkForUpdates();
    } else if (process.platform === 'darwin') {
      const name = `phone-lab-Desk-Mac-${process.arch}.dmg`;
      if (!(info.assets || []).includes(name)) return;
      const r = await dialog.showMessageBox(win, { type: 'info', message: `phone-lab Desk ${info.version} is available`, detail: `You have ${app.getVersion()}. Download it, then open the file and drag the app into Applications.`, buttons: ['Download', 'Later'] });
      if (r.response !== 0) return;
      const file = path.join(app.getPath('downloads'), name);
      await download(`${server}/desktop/${name}`, file);
      shell.showItemInFolder(file);
      new Notification({ title: 'phone-lab Desk', body: `Version ${info.version} is in your Downloads folder.` }).show();
    }
  } catch (e) { if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Update check failed', detail: e.message }); }
  finally { checking = false; }
}

function buildMenu() {
  const serverMenu = { label: 'Server', submenu: [
    { label: 'Change server…', click: () => showConnect('') },
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Developer tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() },
  ] };
  const template = process.platform === 'darwin'
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, serverMenu, { role: 'viewMenu' }, { role: 'windowMenu' }]
    : [{ label: 'File', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }, serverMenu, { role: 'viewMenu' }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu(); createWindow();
  const saved = readConfig().server;
  if (saved && (await probe(saved, 3000)).ok) return openServer(saved);
  // Auf dem Mac mit den iPhones läuft der Server lokal: dann ohne Frage verbinden
  if (!saved && (await probe(LOCAL, 1500)).ok) { const c = readConfig(); c.server = LOCAL; writeConfig(c); return openServer(LOCAL); }
  showConnect(saved ? `Could not reach ${saved}. Is the Mac on and connected to Tailscale?` : '');
});
app.on('window-all-closed', () => app.quit());
