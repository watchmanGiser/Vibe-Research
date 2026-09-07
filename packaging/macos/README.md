# Mac 独立 App 本地安装包（v1.1.0 / M40 候选）

M40 将业务版本统一为 1.1.0、构建号 40，并固定安装版研究执行层为 `controlled_mcp`；从 DMG 打开或拖入应用程序后使用同一工具边界，不改变用户的 Agent 开关。当前签名、公证、隐私与业务验收见 [M40 记录](../../docs/发布候选与隐私验收_M40_2026-09-07.md)。旧 M37/M38 包保留原版本，不能改名冒充新版本。

M34 将 M33 的“启动后打开浏览器”改为独立 AppKit + WKWebView 窗口，继续使用 Simon 确认的“石墨底＋橙色凤凰羽翼 / V”图标。现有页面、导航与品牌 Logo 不变。官方 Codex SDK 与捆绑引擎锁定 0.153.4，零 fork。

原生窗口依据见 [M34 验收](../../docs/Mac独立窗口与引擎升级_M34_2026-09-06.md)，完整业务与数据缺口见 [M36 验收](../../docs/数据可用性与安装版验收_M36_2026-09-06.md)。M37 在此基础上锁定 Python 依赖并验证含空格路径；每轮结果独立记录。不恢复 Electron，不公开发布。

## 形态

`VibeResearch.app`（AppKit 独立窗口 + 系统 WebKit）+ 官方 Node 22 + Astral standalone Python 3.12 + 锁定的 npm 生产依赖 + 当前前端生产构建。
Node 同一进程运行已有 API 和生产静态网关；没有 Vite 开发服务器，也不需要客户安装 npm、Python、Homebrew。
工作台固定为 `http://127.0.0.1:5938/`；被占用就明确失败，不导航其他程序、不开 LAN。
开发服务 5940/8765 与项目39的5930不改变。

用户数据在 `~/.vibe-research-desktop`，Codex 登录在其 `codex-home`；首次需要用户在页面接入自己的 AI。
不复制开发仓库 `.local`、个人登录态、浏览器 API key、持仓或研报。卸载应用不删除数据。
AI 接入、主题和对话使用 App 自己的持久化 WebKit 存储，不会自动读取 Chrome/Safari 的 key、聊天或设置。首次打开 App 需重新接入 AI；已有安装版数据根中的研报、台账保留。
关闭窗口不退出服务，重新点击 App 图标恢复当前页；Cmd+Q 退出服务、停止本进程对话。独立后台研究请先在研究页取消。资料下载/保存期间退出会提示等待。
支持系统文件选择和保存面板、正文预览、复制粘贴、Cmd+R 刷新及 Cmd+1 首页。外部链接在系统浏览器打开，不替换 App 工作区。没有 JavaScript 到本地 Shell 的桥接。

## 构建

开发者需要 Node/npm、uv、Xcode Command Line Tools、网络。在活动仓库运行：

```sh
node packaging/macos/build.mjs
```

可通过 `VRA_MAC_NODE_ARCHIVE` 指定已下载的官方 Node 归档以减少重复下载；必须匹配代码中固定的官方 SHA256，否则构建拒绝，不接受未校验的本机运行时替代品。

只在 `.local/mac-builds/<时间戳>/` 新建版本化目录。白名单选择当前源文件（包括获授权的未提交增量），不复制整个脏目录。
Node 官方归档固定版本与 SHA256；Python 3.12.13 用 uv 新装，40 个运行依赖按 `python-requirements.lock` 固定版本并强制检查下载哈希，随后检查依赖完整性。包内记录锁文件哈希和包括 pip 在内的版本清单，不暴露临时 wheel 路径。
这锁定了 Python 运行依赖，不承诺 DMG 逐字节可复现：构建时间、编译工具链以及源包构建依赖仍会影响输出。
npm 使用已有 package-lock，忽略安装脚本；随包保留上游许可证和构建清单。
构建产出 DMG、SHA256 与本地 `.app`。本地 ad-hoc 完整性签名不是 Developer ID 公证。

## 当前门槛

- 首批仅 Apple Silicon / macOS 13+。不宣称 Intel 已支持或实体 Windows 验收。
- 建议安装至 `/Applications/VibeResearch.app`。含空格的产品或数据路径默认使用已有受控工具模式，不启用 Shell，也不改变 AI 来源或首页 Agent 开关；显式指定 `shell_hooks` 时仍拒绝含空格的根路径。
- M32/M33 已有迁移、Claude问答及签名历史证据；M34 以本轮独立窗口/引擎/产物检查为准。仍需干净外部 Mac、全离线及跨机器升级验收，不能用开发机测试替代。
- 签名证书存在不代表已签名/公证；Apple 公证上传与公开发布另行授权。不能为了绕过 Gatekeeper 关闭系统安全功能。
- M31 全量代码/功能审计是产品开发快照验收，不替代安装版完整业务验收。

## 借鉴与依据

运行依赖的版本基线在 `python-constraints.txt`，仅在有意升级并准备重新验收时调整，再生成锁文件：

```sh
uv --no-config pip compile .agents/skills/data-access/scripts/requirements.txt \
  --constraint packaging/macos/python-constraints.txt \
  --python-version 3.12 --python-platform aarch64-apple-darwin \
  --generate-hashes --no-header --no-annotate \
  --output-file packaging/macos/python-requirements.lock
```

重新构建后检查 `python-packages.txt` 并运行导入与业务回归；不要把锁文件哈希校验当成漏洞审计。此锁只用于 Mac arm64 包，不替代 Windows 平台验收。方法依据：[uv 依赖编译与锁定](https://docs.astral.sh/uv/pip/compile/)。

- [Apple：打包 Mac 软件](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)：应用与分发容器、签名/公证分开处理。
- [Apple：Developer ID](https://developer.apple.com/developer-id/)：公开分发的身份与 Gatekeeper 验证。
- [uv Python 发行来源](https://docs.astral.sh/uv/concepts/python-versions/)：使用 Astral 的可分发 Python 构建，不拷开发机虚拟环境。
- [python-build-standalone](https://github.com/astral-sh/python-build-standalone)：可再分发 Python 运行时。

没有 fork Codex 引擎或修改上游运行时。

M37 运行后完整性门槛：除构建时验签，还需在安装版实际取数、回测和计算之后执行严格验签。
启动器禁用 Python 字节码写入的环境标记必须穿过子进程白名单，快速计算另行固定禁写；
否则 `__pycache__` 会在使用之后破坏 App 签名。不得靠事后删缓存或再次签名伪装通过。

## 显式 Developer ID 签名（M38）

只有获得签名授权后使用，输入必须是已验收且严格验签通过的 `.app`；原包不改动。

```sh
node packaging/macos/sign-candidate.mjs \
  /absolute/path/to/VibeResearch.app \
  /absolute/path/to/new-candidate-directory \
  CERTIFICATE_SHA1 TEAM_ID
node --test packaging/macos/tests/sign-candidate.test.mjs
```

脚本要求现有的匹配 Developer ID Application 身份，不导出私钥、不接受 ad-hoc 降级。
遍历真实文件内容识别 Mach-O（不依赖扩展名或可执行位），拒绝越界链接及当前未支持的嵌套 bundle；
逐个签子组件、最后封装主 App，全部使用时间戳和加固运行时。只给捆绑 Node 与 Codex code-mode-host
保留 JIT/动态可执行内存例外，不沿用上游的调试、DYLD 环境或关闭库验证权限。

产出 `VibeResearch-notary.zip` 和 `signing-record.json`，**不自动上传**。签名之后须实跑导入、
Agent 工具并再次严格验签；随后独立使用 Apple 官方 `notarytool` 或 Xcode 的 `developer-id`
上传通路。不能选 App Store 发布通路。公证需读取实际 Accepted 结果、装订票据并做 Gatekeeper 验证，
不是上传成功即可。DMG 与其中 App 的票据分别验证；最终文件变动后重算 SHA256。

本机 M38 结果与尚未关闭的门槛见 [正式签名与公证验收](../../docs/Mac正式签名与公证_M38_2026-09-07.md)。
签名源的 `build-manifest.json` 和 NOTICE 保留原 M37 构建时状态，当前分发状态以 M38 外部验收记录、
Apple 票据与严格验证为准，不修改已经签名的资源来回填状态。
