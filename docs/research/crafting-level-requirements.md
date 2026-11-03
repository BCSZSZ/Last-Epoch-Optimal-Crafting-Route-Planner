# 制作等级、雕文资格与 roll 保留：1.5.3 原生核查

审计对象是本地 Last Epoch **1.5.3 / Steam build 26087601**，日期为 2026-11-03。本轮重新读取当前 `GameAssembly.dll`，SHA-256 为 `323e9183f3bee600b6c9e1c469218b9de926e9044f2ca3d44fae8a0ec9a91464`。全局元数据 SHA-256 为 `2a4e8440606c420345934158b6784d8f5d8b0184f32fd91af0e9e0903ba94f83`。没有启动游戏、修改游戏文件或进行制作频次实验。

结论和每个方法的当前字节哈希保存在[结构化声明](../../research/crafting-level-claims.json)。`VERIFIED` 指所述分支已从当前原生指令读出，不表示客户端实测。Cpp2IL 的 `LE.dll` 只用于名称、签名和字段偏移；其占位方法体不是行为证据。该文件本轮哈希也记录在声明的 `source.dummyAssembly`。

## 1. 可供 TypeScript 直接实现的等级公式

所有公开装备输入使用显示阶数；原生 `affixTier` 使用 **stored tier = 显示阶数 − 1**。定义：

| 显示阶数 | stored tier | `L(stored)` | 最高阶额外项 `H(stored)` |
|---|---:|---:|---:|
| T1 | 0 | 1 | 2 |
| T2 | 1 | 3 | 6 |
| T3 | 2 | 6 | 12 |
| T4 | 3 | 10 | 20 |
| T5 | 4 | 14 | 28 |
| T6 | 5 | 15 | 30 |
| T7／T8 | 6／7 | 16 | 32 |

有效非负输入中，stored 大于5统一取16；`H=2×L`。**这里没有读取词缀定义的 `levelRequirement`。** 四张跳转表均从当前 DLL 解码并单独计算哈希。[声明 L01、L07]

### 当前普通装备需求等级

```text
contributes(a) = a.specialAffixType == Standard(0)
                AND a.sealedAffixType == None(0)

eligible = item.affixes.filter(contributes)
sum = -10 + Σ L(a.storedTier) for a in eligible
highest = max(a.storedTier for a in eligible, default=0)
affixRequirement = clamp(sum + H(highest), 1, 90)
itemRequirement = max(base.levelRequirement, affixRequirement, 1)
```

`ItemAffix.CanContributeToLevelRequirement`（`0x1216770`）先检查 `ItemAffix+0x18` 为0，再检查 `+0x38` 为0。因此实验、个人、套装等非 Standard 类别都不贡献；普通封印、原初封印和腐化槽也都不贡献。不能仅用“所有词缀阶数总和”，也不能把实验词缀当普通词缀加到这个等级式中。[L02]

`calculateAffixLevelRequirement`（`0x120E4B0`）计算上述词缀项；`CalculateLevelAndClassRequirement`（`0x11F9920`）普通分支再与底材等级和1取最大。**90只钳词缀表达式，不钳底材。** 合法普通四栏均为 Standard T7 时，词缀需求是86；合成的五个普通未封印T7输入才会把该表达式钳至90，不能因此允许五个普通栏。暗金、套装装备稀有度和传奇有独立分支，本式不能替代其专属要求。[L03]

### `CalculateLevelRequirementWithAffixAtTier(id, targetStoredTier)`

```text
sum = -10 + L(targetStoredTier)
highest = targetStoredTier
for a in current item.affixes:
    if a.id == id: continue
    if not contributes(a): continue
    sum += L(a.storedTier)
    highest = max(highest, a.storedTier)
return max(base.levelRequirement, min(sum + H(highest), 90), 1)
```

目标是假想词缀，**无条件加入一次**；仅其他已有槽使用 `contributes`。所有同ID已有对象均被跳过。该函数本身不检查目标是不是实验、已有封印、是否有碎片或是否能出在底材上，不能把它当作制作资格验证器。[L05]

本方法的 Cpp2IL 地址描述长度只有 `0x2E0`，会在完整尾部之前截断。本轮进一步读取 PE unwind 范围 `[0x11F9E90, 0x11FA2C8)`，并审计至下一方法之前的 `0x440` 字节；覆盖90上限、与底材／1取最大、返回及两张跳转表。完整跨度哈希为 `b0be3b95aff0b98ca48776e8ed43955d0f345414c4978b1000418820dc568045`。这一扩展没有改写既有中央地址索引。[L05、方法 `withAffix.spanNote`]

### `CalculateLevelRequirementAfterShard(id, tiersToAdd=1)`

```text
existing = first a in item.affixes where
           a.id == id AND contributes(a)
if existing exists:
    targetStoredTier = existing.storedTier + tiersToAdd
else:
    targetStoredTier = 0
return WithAffixAtTier(id, targetStoredTier)
```

查找条件藏在独立 closure `0x1231700`，不是单纯的ID匹配。closure 在 `0x1231709–0x1231723` 同时检查ID、special为0及sealed为0。已有同ID实验／封印对象不被视为该方法的 existing；不存在合格对象时总是假想T1，`tiersToAdd` 不会把新加词变成T2／T3。主函数 `0x11F9D90` 再把结果交给上述 hypothetical helper。[L04]

这也影响暴击选中已有实验槽的等级判断：执行层可以将该槽加阶，但其 `AfterShard` 等级检查使用的是上述假想T1路径；不能擅自改成“实验实际加一阶后重新算装备等级”。它是原生调用逻辑与一个通用理想校验器的区别。[L04、L08、L12]

### `GetMaxAffixTierForLevel(id, level)`

原生从 stored 6 递减测试至1，返回首个 `WithAffixAtTier(id,t)<=level` 的t；全部不满足便返回0。**返回0不证明T1可制作**，因为该循环没有检查stored0。本 helper 最大返回stored6/T7，也不能解释为T8支持。公开接口应另做合法T级、底材ID、操作上限和具体等级门槛验证。[L06]

## 2. 底材、词缀定义与角色等级字段

| 用途 | 原生字段／偏移 | 当前快照字段 |
|---|---|---|
| 装备类型、底材索引 | `ItemData.itemType +0x2C`、`subType +0x2E` | `items.bases[].baseTypeId`、`subTypeId` |
| 底材装备等级 | `ItemList.BaseItem.levelRequirement +0x24`，EquipmentItem继承 | `items.bases[].definition.levelRequirement` |
| 底材职业／专精资格 | `EquipmentItem.classRequirement +0x40`、`subClassRequirement +0x44` | `definition.classRequirement`、`subClassRequirement` |
| 某件物品上的阶数／roll | `ItemAffix.affixTier +0x12`、`affixRoll +0x13` | 状态中的stored tier与roll byte |
| 某件物品上的特殊／封印类别 | `ItemAffix.specialAffixType +0x18`、`sealedAffixType +0x38` | 状态及定义分类，二者不可混用 |
| 词缀定义自带等级字段 | `AffixList.Affix.levelRequirement +0x48` | `affixes.affixes[].definition.levelRequirement` |

数据来源为[当前底材](../../data/game/1.5.3/items.json)和[当前词缀](../../data/game/1.5.3/affixes.json)。`GetItemLevelRequirement`（`0x1227000`）按实际type/subtype取底材字段；`GetLevelAndClassRequirements`（`0x1227DB0`）同时取等级、职业和专精字段。底材不存在时的101等原生哨兵值不能变成一个“合法101级底材”默认值，产品应拒绝未知输入。[L07]

独立的 `AffixList.getAffixLevelRequirement`（`0x11A1810`）会返回词缀定义的 `+0x48`。它与本报告等级公式是不同代码路径。本轮只证明该字段没有被这几个制作／装备等级函数使用，不扩大宣称已经还原其所有掉落或生成用途。[L07]

`CheckForgeCapability` 在 `0x1167EC6` 取得 `CharacterInfoProvider`，调用其 `getLevel()`，然后在 `0x1167F41–0x1167F48` 比较：

```text
playerLevel >= item.CalculateLevelRequirementAfterShard(selectedAffixId, 1)
```

因此需求必须携带真实 `playerLevel`，不能从物品的底材等级推断。底材／词缀兼容性则调用 `CanForgeOnItem(type,subtype,base.classRequirement,alreadyOnItem)`，使用的是底材职业要求；不能把这个参数偷偷换成玩家当前职业。[L08；兼容性与位枚举见[词缀操作审计](affix-actions-audit.md)]

该门槛也适用于绝望。即使成功封印会降低最终装备等级，也要先通过“如果本次是普通加一阶”的门槛。额外暴击加阶在主操作之后再次使用 `AfterShard` 检查；不通过时不升级，也不重新选其他对象。外层暴击退款仍结算。[L08]

## 3. 特殊类别：执行 helper 与玩家合法动作分开

当前 `Affix.HasShard`（`0x11B44D0`）原生表达式是：

```text
definition.rollsOn == Equipment(0)
AND definition.specialAffixType IN {Standard(0), Set(3)}
AND definition.canRollOn != [41]
```

最后一项是“候选类型列表仅有41”时没有碎片；不是“列表含41就全部排除”。对当前1156项快照复算，508项 `HasShard=true`；12项实验定义全部为false。[L11]

| 类别 | 普通碎片主动作的解释 |
|---|---|
| Standard 0 | 还需满足HasShard、实际底材兼容性、未封印、容量、阶数、角色等级、FP等门槛 |
| Experimental 1 | `HasShard=false`，无限实际材料不创造实验碎片；不能据 permissive helper 生成实验碎片ADD／UPGRADE／Despair路线 |
| Personal 2等 | `HasShard=false`，同样不能作为普通碎片主动作 |
| Set 3 | 可能有碎片，但还存在独立的同组资格分支；仅凭HasShard不能全部放行 |

`CanForgeOnItem`／`CanUseShardOnItem` 和 `AddAffixTier` 的内部执行代码本身不做上述 HasShard 存在性校验；在人工注入“特殊ID且库存非零”的状态下观察到它们可以继续，并不证明玩家拥有那种碎片。**HasShard属性是已核实事实；规划器据此约束普通玩家可执行域是明确的模型解释。** 完整UI／库存生成图没有在此重新展开。[L11]

反过来，不能因为实验没有普通碎片，就把它从所有其他操作的池中删去。`AddExtraAffixTier` 遍历未封印、stored `<4` 的对象时没有Standard-only条件；已有实验可作为暴击额外加阶对象。浩劫的已有未封印池也无此条件，见[原子动作审计](affix-actions-audit.md)。T8若在原初封印槽，会因sealed被排除，不能只按显示阶数推断资格。[L12]

普通升级和绝望共同受显示T5的普通制作上限约束；已有T5或以上不能以普通碎片继续升级。绝望的有效对象为T1–T4，成功保原阶，失败走加一阶。Set3在 `CheckForgeCapability 0x11682A6–0x116836F` 另有重复组检查；本报告没有完成该closure的全语义，Phase 1若不支持应明确返回unsupported，不默认放宽。[L10、L12；[绝望及费用审计](affix-actions-audit.md)]

## 4. 新增加词与 Chaos／Order／Despair

`CheckForgeCapability` 没有统一禁止“选定ID当前不存在时附带这些雕文”。但 Forge 会先判定雕文对当前动作是否有效：[L09]

| 当前普通碎片动作 | Chaos | Order | Despair |
|---|---|---|---|
| 新ID加T1 | 不启用身份重抽 | 不启用保roll | 不封印新T1 |
| 已有未封印合法目标 | 启用升级后重抽身份 | 启用普通主升级保roll | 无普通封印槽时启用一次封印检定 |
| 已有普通封印槽 | 依其他合法条件 | 依其他合法条件 | capability拒绝，即使目标ID原本不存在 |

无效果的新ID组合仍可执行ADD，但对应雕文的有效／消耗标志保持false。路线候选生成可以排除这些无效搭配，报告不得把它们解释为“先加T1再自动封印／重抽”。希望的独立FP保护不属于这三种无效新ID搭配。[L09；完整FP顺序见[FP审计](forge-fp-audit.md)]

核心地址：Chaos在 `0x11690C8–0x116915F`，Order在 `0x1169024–0x11690BE`，Despair在 `0x1168F82–0x116900E`。绝望已有普通封印槽的拒绝在 `0x1168141–0x1168175`。以上限定为普通碎片路径；其他符文（例如rune subtype11）也可设置相关内部flag，不在本轮产品规则范围中。[L09]

## 5. 成功封印、失败升级和 Order 的 roll／列表顺序

`SealAffix`（`0x1209940`）对成功封印做以下变更：[L10]

1. 从当前列表移除选中的同一对象，再把它放到列表最前。
2. 设置 `sealedAffixType=Regular(1)`，并设置物品的普通封印占用标志。
3. 重新计算普通物品rarity；不改该词缀的tier或roll byte。

不能只在原索引上加一个sealed布尔值后宣称列表仍是原生顺序。后续救赎的逐槽处理和其他索引相关动作要看到封印后的列表顺序。[L10；顺序后果见[词缀操作审计](affix-actions-audit.md)]

失败绝望则继续 `AddAffixTier` 的普通升级分支：先阶数加一，随后重抽roll，再结算该动作的费用、可能暴击、退款和低FP保留。按用户政策，必要封印失败在这个动作完整结算后停止，后续路线动作次数为零。[L10；[FP后处理](forge-fp-audit.md)]

Order的保留flag在同一次Forge调用中同时传给普通主升级和额外暴击函数，但后者有两种写法：[L10]

| 代码路径 | 是否保留roll |
|---|---|
| 普通主升级 | `preserveRollWithinTier=true`时保留 |
| 暴击专门主目标路径 | 同一个flag为true时保留 |
| 暴击fallback随机候选路径 | 无条件重新抽roll；即使随机选中了主ID也一样 |
| 成功绝望封印 | 保持原roll，与Order无关 |

Forge 的 `rsp+0x80` 仅在有效Order分支被置true，并于 `0x116A16D–0x116A18A`、`0x116A29A–0x116A2A8` 分别传入两个函数。额外加阶专门主目标在 `0x11F5E72` 检查flag；fallback在 `0x11F60B4–0x11F60FA` 无条件 `RandomByte`。因此“Order使所有额外加阶都保roll”不是当前代码行为。[L10]

## 6. 可复现边界例子

以下是纯等级参考模型，不包含概率抽样：[全部34项夹具](../../research/crafting-level-claims.json)

| 操作／状态（底材等级0） | 需求等级 |
|---|---:|
| Standard `T7,T7,T1` | 55 |
| 上述状态新增一个Standard T1 | 56 |
| 四栏`T7,T7,T1,T1`对其中一个T1尝试绝望的门槛 | 58 |
| 上述绝望成功，原T1进入普通封印槽后 | 55 |
| 新加T1之后，暴击要将这个T1额外升到T2的门槛 | 58 |
| Standard T5＋任意阶实验词缀 | 32 |
| 对上述实验ID调用AfterShard的假想T1门槛 | 33 |
| 直接WithAffixAtTier假想把该ID放为T5 | 46 |

例如56级角色可以从`T7,T7,T1`新增T1，但额外暴击选中这个新T1时因58级门槛不能再升阶；暴击退款依然发生。56／57级角色无法先对四栏中的T1尝试绝望，虽然成功结果的装备需求只有55级。这些反例适合检验“资格与成功终态混算”错误。[L08]

无游戏、无第三方库即可运行参考校验：

```powershell
py -3.11 -X utf8 scripts/check_crafting_level_examples.py --verify-only --summary
```

核对当前安装字节、跳转表与常量：

```powershell
py -3.11 -X utf8 scripts/check_crafting_level_examples.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch' --summary
```

本轮结果：34项参考夹具通过，508项HasShard快照计数一致、实验计数为0；本地DLL与元数据哈希匹配，22个方法跨度、4张跳转表和14个float32常量核对通过。脚本只读取本仓库及显式指定的游戏目录，不导入父项目缓存。这证明提交的参考公式、边界例子和已审字节一致；不冒充生产TypeScript引擎已验证，更不冒充客户端实测。

## 7. 未展开范围

已具备普通Standard制作等级、主升级／暴击等级门槛和上述glyph／roll实现所需证据。仍明确保留：Set3重复组closure的完整语义、非普通装备的完整专属等级公式、词缀定义等级字段在其他系统的用途，以及完整UI／库存材料产生图。规则实现应保持这些边界；无需为本报告已有的整数等级公式等待PRNG位级重放。
