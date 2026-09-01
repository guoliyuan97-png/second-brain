/**
 * Electron 桌面壳(W5)——W1 拍板的最终形态,业务零返工的兑现。
 *
 * 壳只做三件事:
 * 1. 确保 8790 上有本机服务(已有就直接复用,没有才拉起 tsx 子进程);
 * 2. 轮询 /api/health 等它就绪;
 * 3. 开一个 BrowserWindow 指向 127.0.0.1:8790,退出时收掉子进程树。
 *
 * 安全模型不变:服务仍只绑 127.0.0.1,Electron 窗口只是它的一个浏览器。
 *
 * Windows 的两个坑(都实测踩过):
 * - spawn 'npx.cmd' 不带 shell:true 会抛 EINVAL(Node 20+ 禁止无 shell 的
 *   .cmd 子进程),异常要自己兜住,否则 whenReady 链断裂、窗口永不出现;
 * - shell:true 时 pid 是 cmd 包裹进程,收尾必须 taskkill /T 杀整棵树。
 */
const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 8790;
const ROOT = path.join(__dirname, '..');
let serverProc = null;
let win = null;

// ── 数据目录指针(W6.1):数据必须住在应用文件夹之外(重打包会重建应用目录)。
// 默认在系统用户数据目录;若存在 data-dir.txt 指针文件则用指针指向的位置 ——
// 用户可在客户端"整理台 → 数据存储"里改选,重打包/升级永不影响数据。
// 指针放在 %APPDATA% 根下、与 second-brain 文件夹平级:
// 用户清理时删掉整个文件夹也不会误伤指针(W6.2 教训:指针曾放在文件夹内,连着数据一起被删)
const pointerPath = () => path.join(path.dirname(app.getPath('userData')), 'second-brain-data-dir.txt');

function resolveDataDir() {
  try {
    const p = pointerPath();
    if (fs.existsSync(p)) {
      const target = fs.readFileSync(p, 'utf8').trim();
      if (target && fs.existsSync(target)) return target;
    }
  } catch {
    /* 指针损坏按默认处理 */
  }
  return null;
}

function healthy() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  serverProc = spawn(npx, ['tsx', 'src/web/server.ts'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32', // .cmd 必须走 shell,否则 EINVAL
  });
  serverProc.on('error', (e) => console.error('server spawn failed:', e));
}

function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('server health check timeout'));
      else setTimeout(async () => (await healthy()) ? resolve() : retry(), 500);
    };
    retry();
  });
}

/** 打包态加载配置:资源目录里的 .env(config 只认 process.env,这里提前喂给它)。
 *  dist 脚本把项目 .env 暂存进 build/ 随包分发;两处都没有时服务照常起,
 *  只是问答/研究会在页面上明确报"未配置 LLM_API_KEY"。 */
function loadAppEnv(appRoot) {
  const fs = require('node:fs');
  for (const p of [path.join(appRoot, '.env'), path.join(appRoot, 'build', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
    }
    break;
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    title: 'second-brain',
    // 渲染进程只加载本地服务页面;按最低权限配置,面向将来打包分发
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 只暴露 webUtils.getPathForFile:拖拽导入需要"文件的真实路径"
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // 同源窗口(如"查看原文快照")允许开新壳窗口;外链交给系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${PORT}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // 服务偶发起得慢:加载失败重试几次,别让白屏一锤定音
  for (let i = 0; i < 5; i++) {
    try {
      await win.loadURL(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── IPC:整理台"数据存储"卡片用(选目录 / 写指针并重启)──────────
ipcMain.handle('sb:choose-data-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择数据存储位置(目录需为空)',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('sb:apply-data-dir', (_e, target) => {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return { ok: false, error: '路径不合法' };
  fs.writeFileSync(pointerPath(), target, 'utf8');
  // 重启后主进程会读指针,把服务切到新数据目录
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

app.whenReady().then(async () => {
  try {
    if (app.isPackaged) {
      // 打包态:服务进程内直跑(esbuild 打的包,不依赖用户机器上的 npx/tsx)。
      // public/、.env 在应用资源目录(SB_ROOT);data 默认在系统用户数据目录,
      // 有指针文件(data-dir.txt)则用指针位置 —— 应用目录会被重打包整个重建,
      // 数据放里面迟早被清空。已有实例在跑就复用它的服务,自己只开窗。
      if (!(await healthy())) {
        process.env.SB_ROOT = app.getAppPath();
        process.env.SB_DATA_DIR = resolveDataDir() ?? path.join(app.getPath('userData'), 'data');
        loadAppEnv(process.env.SB_ROOT);
        // 相对 main.cjs(electron/) 的上一级:打包后 build/ 在 resources/app/build
        await import('../build/server.mjs');
        await waitHealth();
      }
    } else if (!(await healthy())) {
      startServer();
      await waitHealth();
    }
    // 服务已就绪(复用已有实例或新拉成功),开窗
  } catch (e) {
    console.error('server not ready:', e.message);
  }
  // 即便服务异常也把窗口开出来,页面上的报错比白屏好排查
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (serverProc && !serverProc.killed) {
    try {
      spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true, shell: process.platform === 'win32' });
    } catch {
      serverProc.kill();
    }
  }
});
