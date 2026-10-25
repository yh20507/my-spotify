// Replay 윈도우 앱
// 웹앱(https://yh20507.github.io/my-spotify/)을 창에 띄우고, 미니 플레이어·미디어 키·로그인 연결을 맡아요.
const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const http = require('http');
const path = require('path');

const APP_URL = 'https://yh20507.github.io/my-spotify/';
const AUTH_PORT = 53682;
const AUTH_REDIRECT = `http://127.0.0.1:${AUTH_PORT}/callback`;
const MINI_SIZE = { width: 380, height: 384 };

let win = null;
let normalBounds = null;
let authServer = null;

// 앱은 하나만 실행돼요. 다시 실행하면 기존 창을 앞으로 가져와요.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 360,
    title: 'Replay',
    backgroundColor: '#15182B',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 창을 내려도 음악이 끊기지 않게
    },
  });

  win.loadURL(APP_URL);

  // 다른 사이트 링크는 평소 쓰는 브라우저로 열어요.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // 인터넷이 끊겼을 때 안내 화면
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: 사용자가 취소한 이동
    win.loadFile(path.join(__dirname, 'offline.html'));
  });

  win.on('closed', () => { win = null; });
}

/* ── 로그인: 브라우저에서 로그인한 뒤 이 주소로 돌아오는 코드를 받아요 ── */
function startAuthServer() {
  if (authServer) return;
  authServer = http.createServer((req, res) => {
    const url = new URL(req.url, AUTH_REDIRECT);
    if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error_description') || url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Replay</title>
      <body style="font-family:sans-serif;background:#15182B;color:#F2F1EC;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h2>${code ? '로그인됐어요' : '로그인하지 못했어요'}</h2>
      <p style="color:#A9AFD6">이 탭을 닫고 Replay 앱으로 돌아가세요.</p></div></body>`);
    if (win) {
      if (code) win.webContents.send('auth-code', code);
      else win.webContents.send('auth-error', err || '알 수 없는 오류');
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    stopAuthServer();
  });
  authServer.on('error', () => { authServer = null; });
  authServer.listen(AUTH_PORT, '127.0.0.1');
  // 10분 안에 로그인하지 않으면 닫아요.
  setTimeout(stopAuthServer, 10 * 60 * 1000).unref();
}
function stopAuthServer() {
  if (!authServer) return;
  authServer.close();
  authServer = null;
}

ipcMain.handle('start-auth', () => {
  startAuthServer();
  return AUTH_REDIRECT;
});

// 로그인 페이지만 외부 브라우저로 열어줘요.
ipcMain.handle('open-external', (_e, url) => {
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' &&
      (u.hostname.endsWith('.supabase.co') || u.hostname === 'accounts.google.com');
    if (ok) shell.openExternal(url);
  } catch { /* 잘못된 주소는 무시 */ }
});

/* ── 미니 플레이어 ── */
ipcMain.handle('set-mini', (_e, on) => {
  if (!win) return;
  if (on) {
    if (win.isMaximized()) win.unmaximize();
    normalBounds = win.getBounds();
    win.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height);
    win.setContentSize(MINI_SIZE.width, MINI_SIZE.height);
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'floating');
  } else {
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMinimumSize(360, 360);
    if (normalBounds) win.setBounds(normalBounds);
  }
});

/* ── 키보드 미디어 키 ── */
function registerMediaKeys() {
  const keys = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'prev' };
  for (const [accel, name] of Object.entries(keys)) {
    try { globalShortcut.register(accel, () => win && win.webContents.send('media-key', name)); }
    catch { /* 다른 프로그램이 이미 쓰고 있으면 건너뛰어요 */ }
  }
}

app.whenReady().then(() => {
  createWindow();
  registerMediaKeys();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAuthServer();
});
app.on('window-all-closed', () => app.quit());
