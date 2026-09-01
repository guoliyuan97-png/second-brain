/**
 * 预加载脚本:向渲染进程只暴露最小能力 ——
 * 1. 拖拽/选择的 File 对象 → 本地绝对路径(webUtils.getPathForFile,Electron 32+
 *    移除了 File.path 属性后的官方替代);
 * 2. 数据目录迁移:弹系统目录选择框 / 写指针并重启应用(整理台数据存储卡用)。
 * contextIsolation 保持开启,页面拿不到任何 Node 能力。
 * 纯浏览器打开时没有 window.sbDesktop,前端自动走内容上传通道。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sbDesktop', {
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  // 返回所选目录绝对路径;取消返回 null
  chooseDataDir: () => ipcRenderer.invoke('sb:choose-data-dir'),
  // 写指针文件并重启应用(切换到新数据目录)
  applyDataDir: (target) => ipcRenderer.invoke('sb:apply-data-dir', target),
});
