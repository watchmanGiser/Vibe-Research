# 广州生产发布

本仓库是 `watchmanGiser` 用于跟踪 `simonlin1212/Vibe-Research` 的 fork。`sync-upstream.yml` 每 5 分钟检查上游；发现变化时只更新 `upstream-candidate` 并创建 PR，不直接修改 `main` 或生产服务器。

生产发布使用不可变版本目录和原子软链接：

```text
/opt/vibe-research/app -> /opt/vibe-research/current
/opt/vibe-research/current -> /opt/vibe-research/releases/<commit-sha>
/opt/vibe-research/shared/.local
```

`.local` 只存在于 `shared/`，每个版本目录通过软链接访问它。发布包、部署脚本和清理逻辑都不得复制、覆盖或删除该目录。

## GitHub 配置

先创建 `production` Environment，并配置至少一名 Required reviewer。然后配置：

| 类型 | 名称 | 值 |
|---|---|---|
| Repository variable | `VIBE_DEPLOY_HOST` | 广州服务器地址 |
| Repository variable | `VIBE_DEPLOY_USER` | `vibe-deploy` |
| Repository variable | `VIBE_PRODUCTION_ENABLED` | 完成全部配置后才设为 `true` |
| Production secret | `VIBE_DEPLOY_SSH_KEY` | 专用 Ed25519 部署私钥 |
| Production secret | `VIBE_DEPLOY_HOST_KEY` | 固定的 SSH `known_hosts` 行 |
| Repository secret（可选） | `FEISHU_WEBHOOK_URL` | 飞书机器人 webhook |

`VIBE_PRODUCTION_ENABLED` 不为 `true` 时，工作流只构建和测试，不会连接生产服务器。

## 发布规则

- 上游变化先进入候选 PR并运行现有跨平台 CI，人工审核合并后才进入 `main`。
- `main` 的 push 再运行现有跨平台 CI。
- CI 成功后，发布工作流再次执行 Linux 测试并生成绑定 commit SHA 的发布包。
- `production` 审批通过后才上传服务器。
- 服务重启后同时检查公网 API、首页和主进程真实工作目录。
- 任一检查失败会自动切回上一版本并重启。
- 当前版本之外最多保留四个旧版本；`.local` 永远不参与版本清理。

## 首次迁移

首次迁移必须在服务器本机以 root 执行，并传入专用部署公钥文件：

```bash
sudo bash /opt/vibe-research/app/deploy/bootstrap-release-layout.sh /path/to/deploy-key.pub
```

迁移前后应核对 `.local` 的 inode、字节数和关键索引哈希，并执行：

```bash
/usr/local/sbin/vibe-healthcheck https://soufly.cn/vibe-research
```

## 击球区原文与观点总结

独立入口为 `https://soufly.cn/dingtalk/`，单独展示完整原文与总结，免登录并适配手机。
它通过 `desktop/dingtalk.html` 独立启动，复用相同消息组件和公开只读接口；
工作台原入口 `/vibe-research/intel/dingtalk` 继续可用，两处读取同一份持久化消息与总结。

页面「资讯雷达 → 击球区观点」分列展示完整去重原文和现有总结，窄屏上下排列。
原文与总结一次展示所有归档内容，不分页、不使用消息栏独立滚动，统一随整页滚动。
原文支持全历史全文搜索和展开全文；总结保留主题、概述、要点及风险，并可定位对应原文。
用户于 2026-10-13 指定钉钉页免登录访问：`/intel/dingtalk` 及其前端静态资源公开，
两栏使用同一个公开、禁止缓存的只读 `/semi/dingtalk` 接口，
原文请求通过 `view=messages` 区分；页面用 `all=1` 一次读取全部原文与总结，
原文筛选支持 `q`、`id`。旧接口的 `limit`、`offset` 保留兼容，不影响历史归档。
其他页面、台账、模型配置和写入接口继续由站点认证保护；公开页匿名加载辅助请求时返回 403，
避免浏览器自动弹出密码框。内部 Bearer 令牌仍仅由 Nginx 注入，不下发浏览器。
公开情报页启动不读取个人笔记或自选台账；从公开页进入其他栏目时使用整页导航，
重新经过正常的认证和台账初始化，不以匿名空缓存替代个人资料。

Nova 用户级 `deploy/vibe-research-dingtalk-raw.{service,timer}` 在北京时间08:00–次日01:00每10分钟运行
`scripts/sync-dingtalk-group.mjs`，将消息同步并去重保存到权限受限的本地存档。
同步成功后 `ExecStartPost` 调用 `scripts/publish-dingtalk-raw.mjs`，把所有长短原文独立原子发布到
`/opt/vibe-research/shared/semi/dingtalk-raw.json`，不依赖模型整理成功。
原文发布只包含正文、发送者、时间、重复计数和散列关联 ID，不发布群会话 ID、凭据或 reaction；
去重保留数字、单位、标点差异，只统一换行与行末空白。原文不按展示窗口或 90 天窗口删除。
本地原文路径由 `DINGTALK_LOCAL_SNAPSHOT_FILE` 指定，服务端由 `DINGTALK_RAW_SNAPSHOT_FILE` 指定；
`DINGTALK_RAW_PUBLISH_ONLY=1` 可仅校验本地存档、不上传。

独立的 `deploy/vibe-research-dingtalk-push.timer` 在北京时间08:01–次日01:00每10分钟触发既有推送服务，
由 `scripts/push-dingtalk-group.mjs` 消费原文服务已验证的存档并整理超过 120 字的观点。生产启用
`DINGTALK_USE_ARCHIVE=1`，避免重复查询及采集临时失败阻断整理队列。两个定时器关闭随机延迟，
调度精度为 1 秒；没有新增内容时跳过重复发布。
模型提供方许可、输出白名单、摘要缓存和失败禁止覆盖规则保持生效；
总结独立写入 `/opt/vibe-research/shared/semi/dingtalk.json`，与原文文件互不覆盖。
图片消息从已校验的 Nova 原图缓存作为本机整理工具的图片附件输入，短图片通知也纳入整理。
通知、公告等以 `kind=event` 记录；明确券商/研究机构来源的研报以 `kind=research` 记录，
保留机构、原报告标题和所附原页识别文字，用“报告称/认为/预计”表达原报告内容，不机械添加待核验。
其余研究判断以 `kind=opinion` 记录；旧的无分类缓存继续兼容。原页识别不冒称完整PDF。
正文及原图内容指纹变化时进入持久整理队列；相同内容重发复用结果，私有指纹不进入公开快照。
每轮最多处理 2 条需要模型的消息（失败也计数），整轮最多 8 分钟；同一内容最多尝试 3 次，
失败后分别冷却 30 分钟、2 小时，达到上限后挂起，重启与重发不会清零。
单条失败保留它已有的有效摘要，其余完成条目照常发布；原文采集与发布独立继续。
识别文字及分段产物留在 Nova，格式问题最多做一次无图片修正，并计入尝试次数。
Codex JSON 完成事件写入私有用量账本，未拿到完整用量时标记未知；每日默认最多 24 次模型启动、
累计已报告用量达到 200 万 Token 后停止发起新整理。详细配置见 [击球区整理运行说明](../docs/dingtalk-processing.md)。
安装 `deploy/vibe-research-dingtalk-push.service.d/limits.conf` 到既有用户服务的同名 drop-in 目录，
为整轮时限、停止时限和进程组清理提供 systemd 兜底。
已整理结果在 Nova `DINGTALK_LOCAL_SUMMARY_FILE` 按消息指纹缓存；
`DINGTALK_SUMMARY_ONLY=1` 仍可本地试运行、不上传。

私有 systemd 配置 `DINGTALK_GROUP_NAME`、`DINGTALK_CONVERSATION_ID`、
`DINGTALK_PUSH_HOST`、`DINGTALK_PUSH_SSH_KEY`；凭据、本地和线上原文均不入仓库或发布包。
模型推理可能通过配置的供应商服务执行，原有 `DINGTALK_GPT_PROVIDER_APPROVED=1` 许可要求继续仅适用于总结流水线。
服务器不安装 DWS 或模型，原文与摘要异常分别提示，不以某一栏失败判定另一栏没有数据。
上线前备份代码、本地存档和流水线配置；不得删除生产 `.local`，版本与回滚遵循上述生产发布规则。

## 简放微博（Nova 采集、广州只读展示）

「资讯雷达 → 简放」对应 `/intel/jianfang`，来源为交易者简放的公开微博（UID `1357064103`）。Nova 的 `vibe-research-weibo.timer` 每 15 分钟运行一次，使用独立匿名 Chrome 会话读取移动版公开时间线，并补取长微博及转发全文。匿名公开接口目前可读最近一页（约 10 条及置顶）；已有记录按微博 ID 累积保存，不将它声称为账号的全历史。置顶内容仍按实际发布时间排序。无法取得全文时明确标注节选，失败时保留已取得的完整正文。

采集程序及锁定依赖在 `scripts/weibo/`。运行时安装到 Nova `~/.local/lib/vibe-research-weibo/`，执行 `npm ci --ignore-scripts`；Chrome 路径由 `WEIBO_BROWSER` 指定，默认 `/opt/google/chrome/chrome`。服务模板在 `deploy/vibe-research-weibo.{service,timer}`，安装到 `~/.config/systemd/user/`。使用 systemd 用户服务与 linger 实现注销、重启恢复；日志由 journald 轮转。

私有环境文件为 `~/.config/vibe-research/weibo.env`（权限 600），可配置 `WEIBO_STATE_DIR`、`WEIBO_BROWSER`、`WEIBO_PUSH_HOST`、`WEIBO_PUSH_USER`、`WEIBO_PUSH_SSH_KEY`。仅记录密钥路径，禁止写入密钥内容或登录 Cookie。采集使用独立匿名访客会话，不访问个人浏览器资料。

原始响应存于 Nova `~/.local/share/vibe-research/weibo/raw/日期/`，累积规范化记录为 `jianfang.json`，推送健康记录为 `last-publish.json`。广州快照为 `/opt/vibe-research/shared/weibo/jianfang.json`，由 SSH 上传临时文件后原子替换。线上 `/weibo/jianfang` 只读该快照，沿用工作台鉴权；可用 `JIANFANG_SNAPSHOT_FILE` 指定隔离测试文件。微博配图由 Nova 保存到状态目录的 `assets/`，先同步到广州 `/opt/vibe-research/shared/semi/assets/weibo/`，再发布正文快照；沿用站点认证与 `/semi-assets/` 路由。页面保留原文、转发作者、配图、北京时间和原帖链接；刷新按钮只刷新展示，页面每分钟检查新推送。最近成功同步超过 45 分钟时显示存档提示。

击球区夜间暂停需同时安装 `deploy/vibe-research-dingtalk-raw.service.d/schedule.conf`、整理服务窗口配置和 `deploy/vibe-research-dingtalk-night-stop.{service,timer}`；日历时区为北京时间，01:00–08:00不触发、不追赶错过的任务，01:00结束在途更新。详见上面的整理运行说明。
