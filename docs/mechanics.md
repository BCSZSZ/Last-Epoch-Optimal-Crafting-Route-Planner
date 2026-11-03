# 当前打造机制与证据矩阵

状态：1.5.3 / Steam build 26087601 的本地静态审阅稿，2026-11-03。当前安装版本由 PlayerSettings 重新读取，文件和 Unity 对象指纹见[快照清单](../data/game/1.5.3/manifest.json)。

## 证据层次

本地原生分支和实际资源为具体概率首要证据；官方资料核对产品含义和版本；社区计算器仅在版本／假设一致时用于交叉验证。独立数学模型精确解、位级 PRNG 重放、客户端制作频次是不同验证层。`VERIFIED` 只限定相应声明的本地代码范围。

完整机器引用见[证据矩阵](../research/evidence-matrix.json)，每项包含来源文件、置信状态、方法 RVA／长度／字节哈希和说明。方法地址登记表比实际行为审计范围大，登记不能替代行为结论。

## 核心结论

| 项目 | 已核实的模型事实 | 详细证据 |
|---|---|---|
| 普通添加／升级 | 合法空侧定加T1，普通升级至T5；实际角色等级参与资格 | [动作审计 §2](research/affix-actions-audit.md#2-普通添加升级与资格) |
| 绝望 | 指定T1–T4对象；成功保阶封印，失败普通加阶；同一起始tier的基础费用参数相同 | [动作审计 §3](research/affix-actions-audit.md#3-绝望原生失败与路线失败分开) |
| 浩劫 | 四未封印且阶数不全相同；只改阶数，拒绝当前值序列，最多10000次保护 | [动作审计 §4](research/affix-actions-audit.md#4-浩劫阶数排列与拒绝抽样) |
| 救赎 | 依当前列表顺序重抽所有未封印崇高身份；后槽读已更新的ID集合 | [动作审计 §5](research/affix-actions-audit.md#5-救赎与混沌的候选和权重) |
| 混沌 | 先升阶再同侧加权改身份；当前Forge路径跳过制作暴击 | [动作审计](research/affix-actions-audit.md)、[FP审计 §5](research/forge-fp-audit.md#5-暴击资格血潜能与材料不能统一乘一个常数) |
| 剥离 | 从未封印Standard池选择；不保护T7；用户不接受的删除在完整结算后立即停止路线 | [动作审计 §7](research/affix-actions-audit.md#7-剥离与失败终止) |
| 希望与冰 | 希望未免FP后才追加冰判定；免FP不自动免材料 | [FP审计 §2](research/forge-fp-audit.md#2-一次-forge-的有序核) |
| 普通／血暴击 | 有操作、封印结果、仓储资格门槛；普通检定失败后才追加血判定 | [FP审计 §5](research/forge-fp-audit.md#5-暴击资格血潜能与材料不能统一乘一个常数) |
| 暴击奖励 | 额外加阶选择偏向primary且受等级约束；即使未能额外升级仍可能退款；主材料和支持也受返还影响 | [FP审计 §5–6](research/forge-fp-audit.md) |
| 费用 | 半开整数抽样＋幸运的缩小上界重抽；余额截断后仍有低FP有序保留 | [FP审计 §3–4](research/forge-fp-audit.md) |
| FP域 | 当前普通可打造装备持久化为0–63；默认1–63等权仅为产品评分约定 | [FP审计 §1](research/forge-fp-audit.md#1-fp-数值域063默认等权域可取-163) |

## 会改变旧研究结果的差异

旧双T7研究里的简化条件不直接成为新引擎：混沌不能统一套普通暴击；未包含低FP保留的曲线不是完整当前费用模型；同一起始tier下封印成功和失败的基础收费入参一致；暴击额外升阶不是“随机另一条”，材料也不必每次消耗。具体更正以原生审计为准，不改写父项目历史课件／XML／冻结研究。

## 官方交叉核对

- [最新补丁索引](https://forum.lastepoch.com/c/patch-notes/39?no_subcategories=false)：本轮查看列出的最新补丁为1.5.3；索引的主题活跃日期不是补丁发布日期。
- [官方符文与雕文说明](https://support.lastepoch.com/hc/en-us/articles/46361877750043-Runes-and-Glyphs)：与浩劫洗阶数、救赎换崇高身份及绝望封印的基本作用核对。
- [官方冰／血潜能介绍](https://forum.lastepoch.com/t/rage-of-morditas-coming-to-last-epoch-october-1/81757/)：核对冰保留FP、血提高暴击的总体作用；不据这份概述填具体联合概率。

原始文件读取与本报告均未启动游戏或收集线上制作频次。剩余边界和实施前完成条件见[未决事项](open-questions.md)。

## 适用公开计算器交叉核对

已实际操作Tunklab计算器，比较32封印格、三类FP的T1→T2完整费用分布和三组浩劫布局。其站点标注1.5.2，只有本地1.5.3已核相同公式的部分进入补充回归，详见[范围与冻结观察值](research/reference-calculators.md)。其无限预算平均次数／费用不冒充本产品的有限FP整路线指标。
