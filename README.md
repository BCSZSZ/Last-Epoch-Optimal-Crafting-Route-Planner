# Last Epoch Optimal Crafting Route Planner

《最后纪元》自动装备打造路线规划器。

当前交付为 **Phase 0：机制研究与数学架构审阅包**。本轮基于当前安装的 1.5.3 / Steam build 26087601 重新读取游戏资源与原生代码；生产求解器、React 网页及部署在研究审阅后实施。

先读 [首阶段审阅结论](docs/phase0-review.md)，再看 [常见打造模式与771x校验](docs/examples/common-crafting-patterns.md)、[7710完整准备路线](docs/examples/7710-to-target-double-t7.md)、[产品需求](docs/PRD.md)、[机制与证据](docs/mechanics.md)及[未决事项](docs/open-questions.md)。所有碎片、符文和雕文固定无限，材料代价不参与优化。

## 原始规范与当前政策

[BOOTSTRAP.md](BOOTSTRAP.md) 是用户提供的 **Master Development Specification v1.0** 原文，与原始附件逐字节一致。其后确认的“必要封印／剥离失手即停止”、等权预算、混沌／剥离首版范围及 GitHub 托管优先约定，记录在本轮文档中。

## 研究与架构

| 文档 | 用途 |
|---|---|
| [产品需求](docs/PRD.md) | 单件装备、固定宏路线与用户确认的行为 |
| [机制审计入口](docs/mechanics.md) | 当前本地代码、资源和官方交叉核对 |
| [词缀与底材数据库](docs/affix-database.md) | 1156词缀、42类型、923底材及提取边界 |
| [概率模型](docs/probability-model.md) | 联合核、零费用闭环、奖励与精度 |
| [状态和接口](docs/state-model.md) | 统一异步规划接口、无限材料与操作限制 |
| [宏动作](docs/macro-actions.md) | 固定动作、重试与失败吸收 |
| [优化目标](docs/optimization-objective.md) | 默认1–63等权、条件统计与排序 |
| [路线搜索](docs/route-search.md) | 有限候选语言、安全剪枝与最优性范围 |
| [验证计划](docs/validation-plan.md) | 已执行研究检查与后续产品验收 |
| [实施计划](docs/implementation-plan.md) | 后续阶段与GitHub／Streamlit／AWS条件 |
| [未决事项](docs/open-questions.md) | 生产前研究缺口和审阅决策 |

## 复现

无本地游戏、无第三方依赖即可核对已提交数据与数学样例：

```powershell
py -3.11 -X utf8 scripts/validate_research.py
py -3.11 -X utf8 -m unittest discover -s tests -v
```

从已安装游戏重新提取需独立研究环境，命令见[研究复现](research/README.md)。快照和方法证据不依赖父项目缓存；游戏原始二进制及虚拟环境不提交。实际执行结果记录在[验证报告](research/validation.json)。

## 发布目标

首选 React＋TypeScript＋Vite＋Web Worker，使用 GitHub Pages 公开提供网页。私有仓库不支持 Pages 时，用户已授权本仓库改为 public。只有生产数值生态确需 Python 且资源适合时考虑 Streamlit，其次使用自有 AWS。当前仓库是研究交付，不是已发布的打造应用。
