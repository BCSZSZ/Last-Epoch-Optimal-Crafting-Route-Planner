# Last Epoch Optimal Crafting Route Planner

《最后纪元》自动装备打造路线规划器。

**[打开公开预览版](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/)**，无需登录。

已实现中文React网页、Worker规划接口、有限固定路线搜索、三类潜能与成功率／消耗分布，已通过实际Pages发布及计算验证。规则基于本机1.5.3／Steam build 26087601的资源及原生实现。[关键机制调查答复](docs/research/key-mechanisms-status.md)、[实施状态与边界](docs/implementation-status.md)、[浏览器和性能验收](docs/product-validation.md)。

[对照原计划的完成度审计](docs/completion-audit.md)逐项列出证据和剩余门槛；物理低性能设备实测仍待补齐；已记录的浏览器内存采样最大值与瞬时分配峰值分开。

[一键设备验证](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/device-check/)使用生产Worker依次运行五类装备×三类潜能，可取消、下载完整记录或复制摘要。[操作与结果口径](docs/device-validation.md)。2026-11-03用户确认目前没有低性能设备，保留该待验收项。

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

产品计算模块使用Node.js 22.12以上版本，依赖版本由package-lock锁定：

```powershell
npm ci
npm run model
npm run check
npm test
npm run dev
```

`npm run build`构建静态网页，`npm run preview`本地验证产物。`npm run model`只读校验运行模型及源代码指纹。显式更新投影时运行`python -X utf8 scripts/build_runtime_model.py`，核查差异后提交。Pages子路径由`PAGES_BASE`指定，Worker地址随Vite构建解析；运行时不读取本地游戏、父项目或账户。

普通加词、升级、必要封印、浩劫、救赎、混沌、剥离均进入同一规则内核。常见7710／771x路线优先比较，其他合法输入仍进入通用候选。默认12秒／48候选的有限搜索通常未穷尽，报告明确写出未证明最优。复杂救赎采用整路线直接采样并展示统计区间；它不是固定首发概率的几何近似。所有假设FP使用同一条固定路线。

无本地游戏、无第三方依赖即可核对已提交数据与数学样例：

```powershell
py -3.11 -X utf8 scripts/validate_research.py
py -3.11 -X utf8 -m unittest discover -s tests -v
```

从已安装游戏重新提取需独立研究环境，命令见[研究复现](research/README.md)。快照和方法证据不依赖父项目缓存；游戏原始二进制及虚拟环境不提交。实际执行结果记录在[验证报告](research/validation.json)。

## 发布目标

采用React＋TypeScript＋Vite＋Web Worker，使用GitHub Pages公开提供网页，工作流见[pages.yml](.github/workflows/pages.yml)。私有仓库不支持Pages时，用户已授权本仓库改为public。只有生产数值生态确需Python且资源适合时考虑Streamlit，其次使用自有AWS。发布结果记录在实施状态和验收文档。
