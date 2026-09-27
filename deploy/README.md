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

## 钉钉群结果展示（Nova 本机处理）

广州服务器只读取 `/opt/vibe-research/shared/semi/dingtalk.json` 的结果快照，
**不在生产服务器安装 DWS，也不把钉钉登录态、凭据或会话 ID 提交到公开仓库**。
本机运行 `scripts/push-dingtalk-group.mjs`：先使用 DWS 拉取指定群的完整消息分页，
按消息 ID 和长文本指纹去重，仅保留最近 90 天；本地保留可供下次去重的完整快照，
推送前生成只含展示字段的结果快照（不含会话 ID、重复消息原始 ID），
通过 SSH 传到 `shared/semi/` 下的临时文件，成功后原子替换。

Nova 本机的 **私有** systemd 用户服务环境（如 `EnvironmentFile` 指向权限 0600 的本机文件）
必须配置 `DINGTALK_GROUP_NAME`、`DINGTALK_CONVERSATION_ID`、`DINGTALK_PUSH_HOST`、
`DINGTALK_PUSH_SSH_KEY`，可按需配置 `DWS_BIN`、`DINGTALK_LOCAL_SNAPSHOT_FILE`；
用户级 timer 每 30 分钟运行，启用 linger 后重启仍可恢复。
推送前校验完整分页和会话身份；校验失败不会替换快照。
不要在发布包中安装服务器侧 DWS 定时器，不要删除 `.local` 或 `shared/semi/`。

网页「资讯雷达 → 钉钉群」只请求 `GET /vibe-research/api/semi/dingtalk`。该接口在 Nginx 以 `/etc/nginx/.htpasswd-vibe-research` 的现有 `vibe` 网页账号单独保护，未验证时返回 401，响应禁止缓存；其他 API 的 Bearer 注入仍由现有配置负责。**生产启用前要核验这条精确路由确实生效**，切勿把原始群消息正文暴露在公开 API 上。
这个结果接口随现有看板对外展示已去重的**消息正文和发送者**；
请勿将不希望公开的群消息加入本地推送源。未生成快照时 API 返回 503，
页面应标记不可用，不把错误显示为没有消息。
