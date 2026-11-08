# Last Epoch Optimal Crafting Route Planner

**步骤显示修订**：结果直接展示Step、操作、验收条件和该步期望消耗FP；默认希望不重复写。删除起手／成功示例展示，保留完整条件分支。[费用口径与验证](docs/step-instructions-20261108.md)。

**当前版本：48FP三种潜能分别选路（2026-11-08）**。主指标统一为初始48FP内完成目标的概率。单独希望、冰＋希望、血＋希望分别求解、分别判断：低于25%显示不推荐，达到25%显示推荐。不再按15%理论成功率或65FP理论均值过滤路线。失手后仍有合法机会就继续；末次耗尽FP同时达标算成功。

普通100级等权池的两源T7、双指定T7目标使用完整装备状态＋剩余FP条件策略。99例×3条件与修改生产代码之前冻结的独立C#结果一致；详细异权池、实验与其他非标准目标保留固定候选评价，并明确显示范围和未完成状态。[新算法、三种条件与验收](docs/finite48-three-profiles-20261108.md)。

[打开公开求解器](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/)。每列可展开起手、成功示例和完整条件路线；下载包含三种策略的JSON，用`npx tsx scripts/check_finite_export.ts <文件>`重新评价导出的选择。

下列2026-11-07及更早条目为**历史版本记录**。其中15%／65FP过滤、65%推荐线和无限FP主指标已经由上述48FP／25%规则替代。

**生产程序求解与实验前缀（2026-11-07）**：第2轮示例驱动生成已进入生产Worker；前缀2独立勾选实验／目标，必要救赎按真实逐槽规则计算。原三例达到人工及更强下限，新增四模式各0–1已有目标、详细真实权重与性能已核对。[范围与证据](docs/production-programs-20261107.md)。

**2026-11-06中文发布记录**：1156个词缀按ID显示中文，保留中英文搜索；该轮详细输入核对及未改变Worker的体积对照见[历史验证记录](docs/detailed-ui-and-localization-20261106.md)。当时求解器以2026-11-07记录为准；现行规则见顶部2026-11-08记录。

**三例驱动求解试验**：求解器经历0/3→2/3→3/3的改进，第2轮已达到7710、7732、7271人工方案及更强已知下限，另24个验证例全部通过。运行`npm run learn:routes -- --quiet`；[原试验方法](docs/example-guided-solver-20261106.md)。现使用同一实现作为生产程序生成模块。

**算法覆盖审查（2026-11-06）**：旧生成器漏掉有效组合；23节点和112例通过不能证明策略完整。7732更优的交错补词＋联合封印窗口现已纳入程序搜索。[原问题与证据](docs/algorithm-coverage-review-20261106.md)。

**7271封印窗口修正**：补入“浩劫至T1或T2就封印”的固定模板，截图案例从25.00%／13.83%／58.83FP改善到84.50%／50.55%／55.68FP；目标T7合计受起始普通槽T7数限制，浩劫步骤标明槽位与阶数。[比较与原因](docs/research/7271-combined-seal-20261106.md)。

**槽位目标输入**：左侧直接勾选目标词缀，右侧已有数量只读；部位默认任意，阶数按钮仅显示1–7。[输入与参考模型](docs/minimal-ui.md)。

《最后纪元》自动装备打造路线规划器。

**新增48FP整件完成率**：结果显示成功率、整件完成率和FP；低于25%标“不推荐”，高于65%标“推荐”，保留65FP放弃。[计算与接口](docs/completion48.md)、[7710／7721全部位置对照](docs/7710-7721-completion.md)。

**当前放弃门槛：65FP**。恰好65通过，只统计最终成功路径；[为何均值65不能唯一推算48FP完成率及两个实际例子](docs/fp65-policy.md)。

**救赎与FP复核**：[7272单中路线、真实权重和阈值建议](docs/research/redemption-7272-and-fp-threshold-20261103.md)。70.35%是无限FP操作成功率；常规L100崇高初始FP均值40.44，固定法器真实权重例预算内完成率约19.89%。用户已确认费用门槛为65FP，已接入生产；恰好65通过。[FP生成与63存储上限](docs/research/fp-generation-reaudit-20261103.md)。

**本轮修复**：补入“剥离后按空槽先补目标，再准备最低阶封印”的固定分支，增加高阶封印组合与纯救赎双赌的有证预排除，简化路线展示。[顺序比较、缺陷原因与剪枝边界](docs/acquisition-order-review.md)。

**极简界面已接入计算**：固定两前缀、两后缀和一封印，按钮选T级，词条可留空；左起始、右简易／详细目标，结果在跨栏按钮下方。简易目标分别填前后缀数量。缺省身份用等权参考，完整身份用实际权重通用池。[输入约定](docs/minimal-ui.md)、[后续预计算设计](docs/precomputation-plan.md)。

**新版求解器**：[23节点的细分结构、完整模板与有证剪枝](docs/hierarchical-solver-v2.md)已接入生产入口。主指标改为操作成功率和最终成功路径平均FP，低于15%或高于65FP的模板显示“已放弃”；计算预算不足单列未完成。[112例逐标签／侧别验收](research/hierarchy-validation.json)

**[打开公开预览版](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/)**，无需登录。

已实现中文React网页、Worker规划接口、按结构生成的固定模板、三类潜能及联合概率／费用评价。旧有限FP曲线和分布保留在研究基线，新主报告使用无余额轴的指标。规则基于本机1.5.3／Steam build 26087601的资源及原生实现。[关键机制调查答复](docs/research/key-mechanisms-status.md)、[实施状态与边界](docs/implementation-status.md)。

[对照原计划的完成度审计](docs/completion-audit.md)逐项列出证据和剩余门槛；物理低性能设备实测仍待补齐；已记录的浏览器内存采样最大值与瞬时分配峰值分开。

[一键设备验证](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/device-check/)使用生产Worker依次运行五类装备×三类潜能，可取消、下载完整记录或复制摘要。[操作与结果口径](docs/device-validation.md)。2026-11-03用户确认目前没有低性能设备，保留该待验收项。

先读 [首阶段审阅结论](docs/phase0-review.md)，再看 [常见打造模式与771x校验](docs/examples/common-crafting-patterns.md)、[7710完整准备路线](docs/examples/7710-to-target-double-t7.md)、[产品需求](docs/PRD.md)、[机制与证据](docs/mechanics.md)及[未决事项](docs/open-questions.md)。所有碎片、符文和雕文固定无限，材料代价不参与优化。

## 原始规范与历史政策

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

普通加词、升级、封印、浩劫、救赎、混沌、剥离沿用同一原子规则。当前普通等权双目标T7使用状态条件策略；非标准目标在固定候选范围比较48FP完成率，范围未完成会单独说明。资源预算只限制本次计算，不是路线筛选门槛。

无本地游戏、无第三方依赖即可核对已提交数据与数学样例：

```powershell
py -3.11 -X utf8 scripts/validate_research.py
py -3.11 -X utf8 -m unittest discover -s tests -v
```

从已安装游戏重新提取需独立研究环境，命令见[研究复现](research/README.md)。快照和方法证据不依赖父项目缓存；游戏原始二进制及虚拟环境不提交。实际执行结果记录在[验证报告](research/validation.json)。

## 发布目标

采用React＋TypeScript＋Vite＋Web Worker，使用GitHub Pages公开提供网页，工作流见[pages.yml](.github/workflows/pages.yml)。私有仓库不支持Pages时，用户已授权本仓库改为public。只有生产数值生态确需Python且资源适合时考虑Streamlit，其次使用自有AWS。发布结果记录在实施状态和验收文档。
