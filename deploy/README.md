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

## 击球区观点（仅 Nova 保存原文）

Nova 用户级 `deploy/vibe-research-dingtalk-raw.{service,timer}` 模板（安装到 `~/.config/systemd/user/`）每 30 分钟只运行 `scripts/sync-dingtalk-group.mjs`，将原文完整同步并去重，保存到权限受限的
`DINGTALK_LOCAL_SNAPSHOT_FILE`，独立的 `scripts/push-dingtalk-group.mjs` 在模型提供方许可确认后同步本地原文，并只对超过 120 字的观点调用 Nova 上配置的 Codex GPT CLI
（可通过 `DINGTALK_GPT_BIN` 指定）；模型将第三方观点整理为主题、概述、要点和待核验风险。原文不自动按 90 天窗口删除。
上线前可用 `DINGTALK_SUMMARY_ONLY=1` 本地试运行，不执行 scp/ssh；原文超过 200000 字、模型调用失败、输出不合规时停止推送，不会退回上传原文。
已整理的结构化结果仅存 Nova `DINGTALK_LOCAL_SUMMARY_FILE`，按消息指纹缓存避免重复费用。
仅白名单摘要经 SSH 原子替换线上 `/opt/vibe-research/shared/semi/dingtalk.json`；线上 API 严格拒绝旧
`messages/text` 格式和多余字段。服务端不安装 DWS 或模型，也不保存群会话 ID、原始消息或发送人。

私有 systemd 配置 `DINGTALK_GROUP_NAME`、`DINGTALK_CONVERSATION_ID`、
`DINGTALK_PUSH_HOST`、`DINGTALK_PUSH_SSH_KEY`；这些凭据和本地原文不入仓库。
**Codex CLI 在 Nova 本地运行但模型推理可能通过配置的供应商服务执行**；在确认第三方资料
允许此类模型处理、且实际模型可用之前，定时器保持停用。确认后需在 Nova 私有配置显式设置 `DINGTALK_GPT_PROVIDER_APPROVED=1`，单独启用 `vibe-research-dingtalk-push.timer`。不得声称为离线本地模型。
页面「资讯雷达 → 击球区观点」显示整理结果，非已核验的事实或投资建议。
当前精确 API 路由由现有 Nginx Basic Auth 保护，缓存禁用。上线前备份旧快照并隔离旧原文，
不得删除生产 `.local`；版本与审批流程遵循 `deploy/README.md` 其他章节。
