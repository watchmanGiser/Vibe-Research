# docs

- [AI接入与执行模式_v1_2026-09-04.md](AI接入与执行模式_v1_2026-09-04.md) — 当前用户产品面的权威方案：第一次只选 AI 来源，Agent 默认开启，模型直连是设置里的受限开关。
- [双引擎任务架构_v3_2026-09-04.md](双引擎任务架构_v3_2026-09-04.md) — 内部任务分层与历史实施记录：deterministic / quick / deep；不再代表用户要手动选择三种模式。
- [release-checklist.md](release-checklist.md) — 发布前清单:只能由维护者拍板 / 提供的事项(License、仓库地址、国产模型矩阵真测、模板易变字段核实)与发布时序(审计在 push 之前)。
- [model-access.md](model-access.md) — 模型接入指南：订阅 / API、Agent 开关、直连能力探针、10 项兼容矩阵和 provider 扩展。
- 编排器细节(状态机 / validator / hooks / 配置 / MCP / HTTP API / 批量 / 提醒 / 矩阵):[../orchestrator/README.md](../orchestrator/README.md)
- 数据源端点目录(自动生成):[../datasources/CATALOG.md](../datasources/CATALOG.md)
- 计算库契约:[../calc/SPEC.md](../calc/SPEC.md)
- provider 模板字段与约束:[../providers/README.md](../providers/README.md)
