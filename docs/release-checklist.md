# 发布前清单(维护者待办)

本清单于 2026-09-07 按 M40 / v1.1.0 继续收口。用户在本地候选验收后明确授权“先发布github”，
允许提交、推送、标签及GitHub Release和Mac附件上传；本轮不部署或修改phoenixtree.ai网站。
先完成隐私复查、独立审计和本次跨平台CI，再公开Release；历史未发布状态保留为当时的检查点。
当前逐项证据见 [M40 发布与隐私验收](发布候选与隐私验收_M40_2026-09-07.md)，以下 M37 数字仍只代表历史基线。
已有公开 v1.0.4 不代表当前双引擎、界面与 Mac 客户端已经发布。
当前完整业务证据见 [M37 记录](发布候选与Mac验收_M37_2026-09-07.md) 与 [M36 记录](数据可用性与安装版验收_M36_2026-09-06.md)，
Mac 构建方式见 [打包说明](../packaging/macos/README.md)。历史测试不自动算作新候选验收。

## 1. 待拍板 / 待填

| 项 | 现状 | 动作 |
|---|---|---|
| License | `LICENSE` 与中英文 README 已采用 MIT，不再是待定项 | 发布前核对依赖许可证；引擎 openai/codex 为 Apache-2.0，本仓库不含其源码 |
| 仓库地址 | 两份 README 已使用 `simonlin1212/Vibe-Research` 的真实 clone 地址 | 发布前核对分支、上游修复及实际发布内容，不再要求重建仓库 |
| 国产模型矩阵 | `providers/{deepseek,qwen,glm,kimi}.json` 的 `matrix.status` 未真测 | 设对应环境变量(`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`——百炼三件套共用;三个百炼模板还要先在 `.local/providers/` 填掉 `{WorkspaceId}`)后 `node orchestrator/src/finance/provider_matrix.ts --provider <id> --model <m>`,按结果回填 `matrix.status / results / note / last_run` 与 `verified_at` |
| 模板易变字段 | 四个模板有 2026-08-26 的 `verified_at`；这是历史文档核对，不是当前实跑证明 | 发布前重新核对厂商文档与实际兼容矩阵，不把模板日期等同模型验证通过 |
| 联系方式与赞赏 | 已按发布规范:X @linsizhen、邮箱、BMC 二维码 `assets/bmc-qr.png` | 核对无误即可 |
| Windows | 发布前须检查本次提交的跨平台 CI；Windows 运行选定契约测试 | 本机 Mac 测试与 CI 不能冒充 Windows 客户实机验收，正常退出后的 Job Object 回收保证仍未验证 |
| 真实模型验收 | M37 原生安装版 core 六阶段无夹具 complete：120 证据、19 计算、最终校验通过；专用配置 Sol/low | complete 门槛已有本机证据；不扩成所有来源 full、所有供应商或所有平台验收。M36 full 的外部缺口仍保留 |
| Mac 客户端 | Apple Silicon / macOS 13+ 的独立 AppKit + WKWebView；SDK / 引擎 0.153.4 | 本机新装、升级、重启、登录保持、对话、研究、报告、回测及中止逐项留证；Intel / 干净外部 Mac 不冒称已测 |
| Apple 分发身份 | M40 App 已 Developer ID 签名、Apple 公证及票据装订；最终安装副本 Gatekeeper 验证通过。DMG 已签名，未单独公证 | 保留另一台干净 Mac 尚未验证的边界；不关闭系统安全功能 |

## 2. 发布时序(审计必须在 push 之前)

1. 执行 `scripts/doctor --net`，安装/隐私/配置故障必须解决；外部限流、缺授权或源侧不可达逐项披露，
   不关闭 TLS、不带入个人密钥、不把 `partial` 或 `failed` 改成全绿。单标的 full 不是 117 个端点全量体检；
2. 后端类型检查及 Node 22/当前开发 Node 回归、前端测试/类型检查/生产构建、Python 的 calc/backtest/data-access 测试全过；Mac 包用自己的 Node/Python 再检查，记录版本和跳过项;
3. 一次真实研究运行 complete(🔴 **必须是完整六阶段、不带 `--seed-from` 的运行** —— 硬测试夹具
   (`--fixture`)会跳过前四阶段、产物按测试运行隔离,**不能替代这一步**;夹具运行的 manifest 带
   `seeded_from` 且 `test_scenario: true`,一眼可辨)(`node orchestrator/src/run.ts --symbol 300308 --market SZ --python <venv>/bin/python < /dev/null`);
4. `codex review`(或 `codex exec` 审查提示)→ 逐条核实(会误报)→ 修 → 复审至 "No actionable regressions";
5. 确认 `.gitignore` 含 `.local/`。对实际候选文件集合与 Git 历史分别扫描密钥，逐条解释测试假串/公开查询常量等命中，不用扫描器退出码替代核实；确认候选没有登录态、用户台账、研报、浏览器存储。真实 Git 索引保持不动，扫描快照留在本地;
6. 英文 README 两遍翻译审查(diff 对照 + 纯英文只读);
6.5 **上游对账**:数据层是从 a-stock-data / global-stock-data / investment-news **移植代码**(不是依赖),
   上游更新不会自动流过来 → 按 [datasources/UPSTREAM.md](../datasources/UPSTREAM.md) 的方法对一次账。
   🔴 判据是「这个修复在本产品的代码路径上会不会发生」,**不是版本号是否落后** —— 必须读 release notes 逐条判断;
7. 维护者明确授权后，核对 License / clone 地址 / 徽章，`CHANGELOG.md` 定版本号，再按授权范围分别
   执行提交、推送、标签与 Release。Windows 测试分支的上传授权不包含合并 main 或发布。

## Mac 候选额外检查

- 使用锁定 Python 运行依赖及下载哈希；记录 Node 归档 SHA256、SDK/引擎一致性、源文件清单、图标与 DMG SHA256。
- 签名后不往 `.app` 内写用户数据；先复制到新的安装目录验证，不覆盖旧测试包。
- 含空格路径走 `controlled_mcp`，显式 Shell 的安全守卫保持有效；从实际安装路径验证，不只测配置函数。
- 未登录时清楚引导连接 AI；额度耗尽、数据不可用、模型不可用必须可见，不能静默切换来源。
- 退出/中止后的子进程、刷新后的状态、历史记录保留分别检查。
- 严格签名必须在真实取数/回测/计算运行后再检查一次：刚构建时通过不能证明运行时未写入 App。
  `PYTHONDONTWRITEBYTECODE=1` 必须穿过 fetch/research/Codex 环境白名单，独立计算环境也必须设置。
- 公证、外部机器验证或完整研究的关键门槛仍未通过时，称“本地候选 / 有条件就绪”，不得称“已可对所有客户发布”。

## 3. 发布后

- 国产模型矩阵结果回填后再发一次小版本;
- `codex-version.json` 的 `verified_on` 随每次版本验证追加;
- 用户反馈的源侧限制(东财 push2 / 百度 403 / 申万证书链 / mootdx)记入 `datasources/` 说明,不在代码里静默降级。
