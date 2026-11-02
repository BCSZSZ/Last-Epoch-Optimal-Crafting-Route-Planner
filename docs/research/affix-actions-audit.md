# 词缀操作原生审计：1.5.3

审计日期：2026-11-03，日本时间。范围是当前安装的 Steam build `26087601`；DLL SHA-256 为 `323e9183f3bee600b6c9e1c469218b9de926e9044f2ca3d44fae8a0ec9a91464`。本报告重新读取该 DLL 的实际指令和本轮从游戏提取的资源，旧 1.5.2.2 研究只用于定位。没有启动客户端进行制作频次实验，也没有把 Cpp2IL 的占位 C# 方法体当作实现。

[结构化审计与34个方法哈希](../../research/affix-action-claims.json)包含方法 RVA、长度、当前原生字节 SHA-256、每项结论的证据引用及已知边界。[当前资源快照](../../data/game/1.5.3/manifest.json)记录完整资源对象哈希、1156项词缀及底材来源。`VERIFIED` 表示所引用的行为分支已从当前代码读出，不表示整套产品引擎已经实现或客户端实测通过。

## 1. 主要结论

| 操作 | 当前已核实行为 | 路线模型必须保留的状态 |
|---|---|---|
| 添加／升级 | 选定ID定向添加；普通碎片升级止于T5；普通升级通常重抽roll | 实际底材、职业要求、角色等级、前后缀容量、ID、阶数、roll |
| 绝望 | 玩家指定对象；T1–T4可检定；成功保原阶封印，失败走升级路径 | 普通封印槽、所有词缀、未封印数量、崇高存在、当前阶数 |
| 浩劫 | 只洗未封印词缀阶数；拒绝原阶数序列；不更换ID | 有序未封印词缀、重复阶数、原阶数序列 |
| 救赎 | 按列表索引逐条重抽所有未封印崇高身份，保阶数和roll | 有序词缀列表、当前每一步的全ID集合 |
| 混沌 | 先升级，再按同侧合法池改身份 | 随升级改变的阶数／roll、当前全部ID和剩余制作窗口 |
| 剥离 | 在未封印Standard池里选一条；T7没有保护 | `sealedType`、`specialAffixType`、事先声明的允许删除集合 |

具体费用、冰／血潜能、暴击、耗材返还在[打造与FP审计](forge-fp-audit.md)中联合还原；不能将这里的身份／阶数分支与一个固定平均费用机械相乘。该份当前Forge审计已确认混沌路径跳过普通／血潜能暴击入口；普通／绝望失败路径也还受碎片库存等资格门槛约束，旧文“混沌也总有12%普通暴击”的概括不能沿用。

## 2. 普通添加、升级与资格

`CheckForgeCapability`（RVA `0x1166960`）在普通制作分支调用实际底材的 `CanForgeOnItem`，排除已有封印ID，并用角色等级与 `CalculateLevelRequirementAfterShard` 比较。在 `0x1167EC4–0x1167F48` 可以看到角色等级取值和比较。因此请求中的制作上下文需要 `playerLevel`，不能从物品等级推断或默认为100。[结构化声明 `ADD_UPGRADE`]

`AddAffixTier`（`0x11F3DD0`）先验证 `FP>0`、普通制作类别和容量。已有未封印词缀若内部阶数小于4则加一；`AffixIsAtMaxCraftableTierOrAbove`（`0x11F8310`）将内部阶数至少4视为普通制作上限。**内部0对应显示T1，内部4对应T5**；普通碎片不能直接将T5升到T6／T7。[`addAffixTier`、`maxCraftable`]

新增词缀在对应侧有空位时按选定ID添加为T1，未提供保留roll时调用 `RandomByte`。已有词缀普通升级在未启用 `preserveRollWithinTier` 时同样重抽roll byte（`0x11F42F3–0x11F4339`）。混沌路径先加阶、重抽roll，然后调用身份重抽 helper（`0x11F4341–0x11F4356`）。[同上]

费用参数存在顺序差别：新增先按内部阶数0计费；普通升级按加阶后的内部阶数计费；绝望成功分支按原内部阶数加一传入费用函数。**对同一起始阶数，封印成功与失败升级传入的基础费用参数数值相同**，只是一个先取旧tier再加一，另一个先加阶再取新tier；不能因显示T级与内部index混用而宣称两种基础费用不同。所有这些分支仍要经过外层 Forge 的后处理，不能把函数入口参数直接当作最后净消耗。

`CanForgeOnItem`（`0x11B1660`）一般走 `CanRollOn`；但“已在物品上且不符合当前兼容性”的词缀还有一个静态例外表回退。该表的完整旧ID成员未在本报告中解码，明确列为 `PARTIALLY_VERIFIED`；不得猜出一组ID并扩张普通合法池。

## 3. 绝望：原生失败与路线失败分开

`getChanceToSealAffix`（`0x120EFE0`）按实际 float32 运算返回下式的阈值：

```text
rawChance = (0.6 + 0.15 × rarity + 0.3 × hasExaltedAffix) × q[tier]
q[T1,T2,T3,T4] = [0.7, 0.46, 0.23, 0.1]
```

这里原生读取的是 `ItemData+0x30` 的 `rarity`，不是直接读取计数函数。`setRarityFromAffixesForNormalMagicOrRareItem`（`0x1212FD0`）对合法普通物品将“完整列表数减去三类封印槽占用数”钳至0–4后写入该字段，所以在该有效状态域内可解释为未封印词缀数。`hasExaltedAffix` 扫描全部词缀的内部阶数是否至少5，本 helper 不排除封印词缀。[`sealChance`、`rarityFromAffixes`、`hasExalted`]

阈值函数自身**不钳至1**；饱和发生在 `RngElement.Roll`：阈值至少1直接成功、至多0直接失败。四未封印且有崇高的T1封印因此确定成功；常见69%／34.5%／15%为标称参数下的T2／T3／T4结果。精确实现需保留资源和指令的float32数值及随机阈值约定，见第8节。

成功分支由 `SealAffix`（`0x1209940`）将原对象移到列表开头，标记普通封印槽，保持阶数和roll，并更新rarity。失败分支在原生中继续普通升级及对应费用／Forge后处理，物品未必损坏。[`0x11F417A–0x11F41F7`、`0x11F42F3`]

**用户路线政策**：若本步骤必须封印成功，该检定失败即为吸收的路线失败；完整结算这一原生动作及其可能的费用／返还后停止。不能抹掉失败时的升阶，也不能增加第二次封印或补救枝。

## 4. 浩劫：阶数排列与拒绝抽样

`canBeRuneOfHavocCrafted`（`0x120E9C0`）要求普通崇高物品、至少四个未封印词缀，并且阶数不全相同。合法普通装备通常正好四个普通栏。`CraftRuneOfHavoc`（`0x11FBF40`）先扣非词缀FP费用，再收集这些词缀的阶数，调用 `ShuffleUntilDifferentOrder`，按原顺序写回tier byte，最后重建／反序列化。此阶段只改阶数，ID和归属该ID的roll byte不随阶数一起搬移；收集池也没有Standard-only条件。[`havocEligible`、`havoc`]

`ShuffleUntilDifferentOrder`（`0x85C1F0`）保留原序列，用Fisher–Yates式洗牌后按值序列比较；重复阶数不能按四个互异对象计24种布局。它最多尝试10000次，极小的“仍是原序列”尾项不是数学上的零。[`differentOrder`、`shuffle`]

在**独立均匀排列模型**下，设不同阶数布局有A种、当前布局x尚未达标：

```text
P(最终仍为x) = A^(-10000)
P(最终为任一指定y≠x) = (1 - A^(-10000)) / (A - 1)
```

`77tt` 有A=6，目标双T7的一种成功布局单发约1/5；`77tu`（t≠u）有A=12，两种成功布局合计约2/11。它们是上述模型的严格排列计算，不是把两个槽各50%相乘；更不是“多次状态变化都能直接用1/p”。原生整数随机数存在有限格点及有状态PRNG，模型精确性与位级重放精确性必须分开描述。

## 5. 救赎与混沌的候选和权重

当前 `rerollAffixIDOfAffix`（`0x1212A10`）枚举single和multi两种定义，候选必须同时满足：[`IDENTITY_REROLL`]

1. 与被改对象同为前缀或同为后缀。
2. 能出现在实际底材、subtype和该底材职业要求上。
3. ID不在当前完整词缀列表中；封印ID与当前自身ID都排除。
4. 候选 `specialAffixType==Standard(0)`。

权重先由 `GetWeighting`（`0x11B3510`）取第一个匹配equipmentType的覆盖值，否则取定义默认weighting；再由 `GetWeightingForGlyphOfChaos`（`0x11B3390`）对小于1的权重乘2并钳至1，其余保持。掉落碎片权重、自然掉落重抽概率均不能代替这个制作权重。

```text
wCraft = w                     if w>=1
       = min(1, float32(2*w))   if w<1

P(i→j | 当前状态) = wCraft(j) / Σ合法当前候选wCraft
```

最后一式为独立归一化权重模型；原生 `GetRandomWeighted` 对候选数不超过128使用stack分支，超过128使用iterator分支。float32累计边界与离散PRNG的位级数值等价仍需专门夹具验证，不能仅凭一个有理数归一化公式声称已经完全重放原生随机代码。

救赎在 `0x11FC230` 中先计费，再按实际列表索引处理每个未封印、内部阶数至少5的词缀；它不能选择只改“坏的T7”。每次helper写新ID并重建物品，下一条看到的是更新后的完整ID集合。阶数和roll保留。源对象本身没有Standard-only过滤：候选池的普通限制不能反推为原始特殊崇高一定不参与。合法原初T8因已封印而被排除。[`REDEMPTION`]

### 当前资源的小例子

本轮从当前资源重新构造通用手套（baseType/equipmentType=4、classRequirement=0）40项普通前后缀池，固定后缀ID7／10，两条前缀均T7，追ID4“施法速度”和ID5“暴击几率”。按实际顺序展开每一步的更新排除集合，在独立归一化权重模型中逐个终态精确求和：

| 救赎起点的前缀顺序 | 一次后两目标同时T7 | 终态数 |
|---|---:|---:|
| ID2近战攻速 → ID26召唤物伤害 | 0.8656509777% | 289 |
| ID4施法速度 → ID26召唤物伤害 | 0.4328254888% | 289 |
| ID26召唤物伤害 → ID4施法速度 | 0% | 289 |

完整池、实际float32权重的精确分数及三次质量守恒结果在结构化审计 `referenceExamples` 中。该小例只验证指定底材与目标下的顺序效应，未包含FP耗尽和完整Forge后处理，也不代表整条最优路线成功率。

## 6. 底材／职业资格和特殊类别

`Affix.CanRollOn` 先将baseType映射为equipmentType，并使用实际底材的classRequirement。`MatchesSpecificity`（`0x10E3D70`）对合法位标志等价于：

```text
req==31 OR specificity==0
OR (req==0 AND (specificity & 1)!=0)
OR (((req << 1) & specificity)!=0)
```

不能直接对两种枚举做位与，它们的职业位相差一位。当前普通装备是baseType0–24中排除空的11／24共23类。神像额外有subtype group回退：equipmentType29／30且subType在10–14或17，分别映射group1／2；前者匹配`canRollOn`含31或33，后者含32或33。虽然这不影响通用手套例子，数据库与通用接口仍要保留该范围。[`CANDIDATE_COMPATIBILITY`]

`AffixType`：前缀0、后缀1、特殊2。`SpecialAffixType`：Standard0、Experimental1、Personal2、Set3、IdolEnchantment4、IdolWeaver5、Corrupted6、FakeUniqueMod7。这些枚举与 `sealedType` 不是同一个维度；当前 `ItemAffix.IsSealed`（`0x1216C50`）只检查 `sealedType>0`。普通Despair封印、原初封印及腐化槽必须分开建模，不能将所有非Standard词缀都叫封印。[`SEALED_AND_T8`]

## 7. 剥离与失败终止

`TryGetRandomAffixThatCanBeRemovedWithRuneOfRemoval`（`0x120BAD0`）先排除所有封印对象，再排除非Standard，随后调用 `GetRandom` 选一个候选。资格不限制T7：有四个合法普通词缀时不能因为其中两条T7就把它们从池中移走。

在理想均匀索引模型下，N条合法对象每条概率1/N，允许删除集合的成功质量为集合与合法池交集的数量除N。原生仍要删除被选对象、结算费用和返还碎片等外层效果；用户政策在此动作结算后判断是否进入路线失败叶。失败路径不能继续“补回误删目标”。[声明 `REMOVAL`；费用细节见另份FP报告]

## 8. 随机与精度约定

本轮实际读取的 `RngElement.Roll`（`0xF6AD10`）在中间概率使用旧uint32高23位构造`U=k/2^23`，并比较 **q≥U**（包含等号）；q≤0与q≥1的短路不消耗随机数。`NextInt(min,max)`（`0xF6A1D0`）返回`min+high32((max-min)*oldUint32)`；合法min<max为上界排除，min==max仍推进随机状态。`RandomByte`返回旧状态高8位。[`RNG_PRIMITIVES`]

因此报告应区分：

- 当前代码中读取并验证的参数和分支。
- 在公开独立抽样约定下，数学转移／吸收模型的精确解。
- 当前原生PRNG及float32累计阈值的位级复现。
- 游戏客户端制作频次实测。

例如假设每个23位格点独立等权，则0<q<1时的Roll概率为`(floor(q*2^23)+1)/2^23`；这仍是一个明确假设，不是已知某个客户端会话初始种子的结果。常见显示百分比可按标称值讲解，但“精确”标签不能混用。

## 9. 复核与剩余事项

当前仓库的独立工具可从已注册当前DLL重新打印指令，无需父项目缓存：

```powershell
.venv/Scripts/python.exe -X utf8 scripts/inspect_native_method.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch' --name '^ItemData::getChanceToSealAffix$'
.venv/Scripts/python.exe -X utf8 scripts/extract_game_snapshot.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch' --verify-only
.venv/Scripts/python.exe -X utf8 scripts/check_action_examples.py
```

第三条命令完全离线，只读取本仓库快照，不导入父项目缓存、不要求安装游戏。它重建40项通用手套池，用Fraction逐步精确求和核对三个救赎例子与质量守恒，并以另一段直接加权抽样代码做独立Monte Carlo交叉验证。默认每例200000次、固定种子20261103，预先固定容差为4个二项标准差加一次命中的整数舍入余量；不随结果调整。本轮三例命中1701／844／0次，均在容差内。浩劫例子同时按不同阶数排列枚举，并用符号尾项保留10000次保护边界以避免下溢。脚本明确输出 `nativeGridBitExact=false`，不将这套参考模型的验证冒充原生格点模型或客户端实测。

生产实现前仍需完成：已有不兼容词缀的forge例外表、加权随机两种实现的精度夹具、完整多属性roll显示／舍入、以及与FP报告的完整联合转移验证。这些都在结构化文件以 `PARTIALLY_VERIFIED` 列出；没有用旧攻略或一组虚构默认概率补齐。
