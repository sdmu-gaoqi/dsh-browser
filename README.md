# 书签导航（dsh-browser）

一个 DSH 插件：在左侧全局面板里加一条**书签带**，下面整块区域就是一个内嵌浏览器。点书签即开网页，每个书签可以单独选**桌面 / 移动端 UA**，随时一键切换。

![书签带](docs/screenshot-strip.png)

### 仓库地址

<https://github.com/sdmu-gaoqi/dsh-browser>

### 一句话价值

装上它之后，DSH 里多了一个「书签导航」面板：常用站点一键打开、内嵌浏览不用切窗口，同一个站点还能一键换成移动端 UA 看手机版页面。

### 能力分类

界面与体验

### 安装命令

装到 **desktop** profile —— 内嵌浏览器依赖桌面端的 guest 桥；`desktop` 换成你实际使用的 profile 名。

```bash
# NPM
dsh plugin --profile desktop add @wagq/dsh-browser

# 源码（本地改代码时用，等价）
dsh plugin --profile desktop add github:sdmu-gaoqi/dsh-browser
```

> 也可以装到 `web` profile：`dsh plugin --profile web add @wagq/dsh-browser`，但纯 Web 版没有 `dshDesktop.browser`，面板只会提示「需要 DSH 桌面端」。

### 兼容与运行要求

- DSH 桌面端（Electron）：在 `0.2.2-rc.5` 上验证。内嵌网页走宿主的 `dshDesktop.browser` guest 桥，纯 Web 版没有这个桥，面板会提示「需要 DSH 桌面端」。
- 平台：Windows 已验证；macOS / Linux 用的是同一套 Electron `<webview>` 机制，未实测。
- 运行环境：需要能联网访问目标站点；guest 继承宿主的沙箱设置（`sandbox: true`、`nodeIntegration: false`、`disableDialogs: true`）。

### 许可证

MIT


### 补充说明

- **它是什么**：顶部 44px 书签带（图标取标签色，移动端书签带手机角标）+ 36px 页面控件（后退/前进/刷新/地址栏/设备胶囊/关闭）+ 剩余全部高度交给 `<webview>`。
- **为什么是 webview 不是 iframe**：GitHub 这类站点用 `X-Frame-Options` / CSP 拒绝被 iframe，webview 是独立 guest 渲染进程，不受此限，和 DSH 内置浏览器同一机制。
- **桌面 / 移动 UA**：`desktop` 用 Windows Chrome UA，`mobile` 用 iPhone Safari UA；落点是 `<webview useragent>` 属性 + `loadURL(url, { userAgent })`。由于该属性只在挂载时生效，切换设备会重建 guest（同一 partition，登录态保留）；同一 UA 内切换书签复用同一个 guest。
- **数据存放**：书签存 `localStorage`（键 `dsh-bookmark-bar:v1`，字段 `id/name/url/device/tags`，旧版数据自动迁移，缺省 `device=desktop`）；最近打开的页面存 `sessionStorage`（`dsh-bookmark-bar:last`），供渲染进程重载后按原地址与设备重开。
- **guest 常驻**：`<webview>` 不在面板 DOM 里，而是挂在 `document.body` 下的一个 fixed 层中，该层用 `getBoundingClientRect()` 跟随面板占位框（`resize`/`scroll`/`ResizeObserver` + 500ms 兜底同步）。切走面板只是把这一层 `visibility:hidden`，webview 从未离开文档，因此 Electron 不会销毁 guest：`bridge.release(lease)` 只在换设备、点「关闭网页」或插件被卸载时发生。
- **登录态跨重启**：桌面端给 guest 的分区是 `dsh-sidebar-browser-<uuid>`（没有 `persist:` 前缀），属于**内存 session**，所以 DSH 每次启动都是干净会话 —— 内置浏览器同样如此。分区的名字由主进程决定并强制校验（`will-attach-webview` 会拒绝不匹配的 `params.partition`），前端改不了。仓库里的 `tools/patch-guest-session.mjs` 把 `app.asar` 里那一行改成 `persist:dsh-browser-<workspace 摘要>`，让登录态真正落到磁盘：
  ```bash
  node tools/patch-guest-session.mjs status    # stock / patched
  node tools/patch-guest-session.mjs apply     # 构建 + 校验（DSH 运行中会被 Windows 拒绝替换，自动暂存为 app.asar.patched）
  tools\commit-guest-session.cmd               # 完全退出 DSH 后运行，替换 app.asar
  node tools/patch-guest-session.mjs revert    # 回滚（需退出 DSH）
  ```
  副作用：DSH 升级会覆盖 `app.asar`，升级后重跑一次 `apply`；改完第一次启动要重新登录一次（旧内存会话本来就没留下数据）。
- **调试面板（Eruda）**：每个页面加载完成后自动注入 [Eruda](https://github.com/liriliri/eruda)，用**它自带的入口按钮**开关面板（Console / Elements / Network / Resources / Sources），插件本身不再画开关、也不管显隐。Eruda 3.4.1 已内联进 `client.js`，走 `executeJavaScript` 执行而不是插入 `<script>`，所以站点 CSP 拦不住，也不需要改桌面端、不需要打包版 DevTools。
- **已知限制**：
  - 面板切走期间网页仍在后台运行（继续占一个渲染进程），这是保活滚动位置、表单状态、登录态内页面状态与播放进度的代价。
  - 渲染进程整体重载（如窗口刷新/重启）后仍会按 `sessionStorage` 重新打开页面，此时页面本身会重新加载。
  - Eruda 注入的是页面内的 DOM：站点用 vdom 整页重绘（或 UI 自己 `innerHTML` 重置 body）时可能把入口按钮一起清掉，重新加载一次页面即可；站内跳转不清文档，不受影响。
  - 宿主不给 webview 注入上下文菜单，插件在 guest 内注入了一个轻量右键菜单（后退/前进/刷新/复制/全选），但会覆盖站点自带的右键菜单。
  - 站内新窗口请求（`target=_blank`）会被宿主拦截并回传到当前 guest 打开，不会弹新标签。
- **权限**：不需要额外权限、不需要外部服务、不写入任何远程数据。


---

## 用起来

- 左侧「全局面板」→「书签导航」。
- 书签带右侧 ⚙ 打开管理弹窗：逐行改名/改网址/选桌面或移动、删除；下面一行是新增；底部「恢复默认 / 取消 / 应用并关闭」。
- 没有打开任何页面时，中间直接给地址输入框，回车即开。
- 页面控件里的「桌面 / 移动」胶囊就地切换 UA 并重载，同时写回该条书签。
- `Esc` 依次关闭：管理弹窗 → 当前网页 → 面板。
