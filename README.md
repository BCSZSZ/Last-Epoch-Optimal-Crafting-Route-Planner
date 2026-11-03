# Last Epoch Optimal Crafting Route Planner

《最后纪元》自动装备打造路线规划器。

**本轮修复**：补入“剥离后按空槽先补目标，再准备最低阶封印”的固定分支，增加高阶封印组合与纯救赎双赌的有证预排除，简化路线展示。[顺序比较、缺陷原因与剪枝边界](docs/acquisition-order-review.md)。

**极简界面已接入计算**：固定两前缀、两后缀和一封印，按钮选T级，词条可留空；左起始、右简易／详细目标，结果在跨栏按钮下方。简易目标分别填前后缀数量。缺省身份用等权参考，完整身份用实际权重通用池。[输入约定](docs/minimal-ui.md)、[后续预计算设计](docs/precomputation-plan.md)。

**新版求解器**：[23节点的细分结构、完整模板与有证剪枝](docs/hierarchical-solver-v2.md)已接入生产入口。主指标改为操作成功率和最终成功路径平均FP，低于15%或高于100FP的模板显示“已放弃”；计算预算不足单列未完成。[112例逐标签／侧别验收](research/hierarchy-validation.json)

**[打开公开预览版](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/)**，无需登录。

已实现中文React网页、Worker规划接口、按结构生成的固定模板、三类潜能及联合概率／费用评价。旧有限FP曲线和分布保留在研究基线，新主报告使用无余额轴的指标。规则基于本机1.5.3／Steam build 26087601的资源及原生实现。[关键机制调查答复](docs/research/key-mechanisms-status.md)、[实施状态与边界](docs/implementation-status.md)。

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

普通加词、升级、必要封印、浩劫、救赎、混沌、剥离均进入同一规则内核。双T7主场景按28个入口标签／23个上层节点选模板，其他合法输入使用明确标注的通用候选。默认12秒／48候选可能未穷尽，报告明确写出未证明最优。救赎逐次更新候选池，以有状态吸收链和奖励界评价；超出状态或执行预算保留未完成，不把首发命中率当重复概率。主报告不再要求起始FP分布。

无本地游戏、无第三方依赖即可核对已提交数据与数学样例：

```powershell
py -3.11 -X utf8 scripts/validate_research.py
py -3.11 -X utf8 -m unittest discover -s tests -v
```

从已安装游戏重新提取需独立研究环境，命令见[研究复现](research/README.md)。快照和方法证据不依赖父项目缓存；游戏原始二进制及虚拟环境不提交。实际执行结果记录在[验证报告](research/validation.json)。

## 发布目标

采用React＋TypeScript＋Vite＋Web Worker，使用GitHub Pages公开提供网页，工作流见[pages.yml](.github/workflows/pages.yml)。私有仓库不支持Pages时，用户已授权本仓库改为public。只有生产数值生态确需Python且资源适合时考虑Streamlit，其次使用自有AWS。发布结果记录在实施状态和验收文档。
