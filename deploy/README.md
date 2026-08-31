# 广州生产发布

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

- `main` 的 push 先运行现有跨平台 CI。
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
