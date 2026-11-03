# 已有不兼容属性词缀的制作例外（O1）

当前 **1.5.3 / Steam build 26087601** 的 `Affix.CanForgeOnItem` 允许一种明确的回退：若普通 `CanRollOn` 判定失败，所选 ID **已经在该装备上**，并且 ID 属于 **`[501, 502, 503, 504]`**，则这个兼容性检查通过。它们分别是力量、智力、敏捷、协调。**体质 505 不在数组中**；505 在普通资格通过时仍能正常制作，不能把“没有例外”误写成“一律禁止”。[证据：`canForge`、`attributeInitializer`，见[结构化证据](../../research/legacy-forge-compatibility.json)]

本报告将这个已有词缀的回退称为“legacy compatibility”，只为对应 O1 审计问题。实际分支没有检查生成版本、物品年龄或历史来源字段。该结论为 **`VERIFIED`：当前本地原生代码与初始化数据静态核查**，不是游戏客户端实测，也不涉及随机概率近似。

## 1. 当前版本与证据范围

本轮直接读取本机安装，不用旧版本研究或父项目缓存替代当前字节：

- 安装：`C:\Program Files (x86)\Steam\steamapps\common\Last Epoch`。
- `GameAssembly.dll`：SHA256 `323e9183f3bee600b6c9e1c469218b9de926e9044f2ca3d44fae8a0ec9a91464`。
- `Last Epoch_Data/il2cpp_data/Metadata/global-metadata.dat`：metadata version 39，SHA256 `2a4e8440606c420345934158b6784d8f5d8b0184f32fd91af0e9e0903ba94f83`。
- 当前资源快照 `data/game/1.5.3/affixes.json`：SHA256 `abdbea6ee8a01e02f16122943da57bf641a504a3ece3fa05ffd1550c1cc79794`，只用于核对 ID 名称及定义，不从资源常量猜初始化数组。

下面的 RVA、长度及 SHA256 均来自当前 DLL；完整值、文件偏移、metadata 位置和声明常量记录在[结构化证据](../../research/legacy-forge-compatibility.json)中。`compatibilityCall` 是明确界定的调用片段，其余行为相关方法按完整定位长度记录。

| 证据 ID | 方法／片段 | RVA | 字节长度 | 当前字节 SHA256 |
|---|---|---:|---:|---|
| `canForge` | `Affix.CanForgeOnItem` | `0x11B1660` | 188 | `196479eda47bd6f8183ad93fe2e4a6b2c1881605df6c1f7c7ac9d86caa747ff1` |
| `canRoll` | `Affix.CanRollOn` | `0x11B19B0` | 301 | `6f1c8d134ba61baae027515858bd6554afa327c59ad6095a4baae7b953ab5650` |
| `attributeInitializer` | `SwapAttributesItemContainer..cctor` | `0x14805F0` | 140 | `5b18efbf94753388321af21d549dfbc36ba1438c6fd6f99eea7ac9be84c1b009` |
| `isAttribute` | `SwapAttributesItemContainer.IsAttribute(ushort)` | `0x1480570` | 115 | `5bf57686e540fd8e7a3002ac74943f760cf4179ad2aa536b6454db55a90410ed` |
| `contains` | `System.Linq.Enumerable.Contains<T>` 共享实现 | `0x84CBE0` | 492 | `c9a971bdaaa68486ecefb808ecf41cf8fcc4ac90bda1d6dcc8c782f44a8d74a9` |
| `compatibilityCall` | `CheckForgeCapability` 调用片段 | `0x1167E3F` | 120 | `df6b75b481b3b7b7485110cbfd33c47e154301586a934e76be0cafd6eae5f306` |
| `classMatch` | `EpochExtensions.MatchesSpecificity` | `0x10E3D70` | 74 | `5c4139a93570c0fce2166674a3a8b894eb615e5cd5dba4155e2b0eb0c71d9bc3` |
| `subtypeGroup` | `GetSubTypeGroup` | `0x1247030` | 64 | `0f941d08cb4257ed04ecc2d1c46b014f0280faeb19014dda170ba02549f57e52` |
| `subtypeCompatibility` | subtype group `CanRollOn` | `0x1246F80` | 175 | `3a1a63952bdc1fb7595bfdaa3aa5dede5a1483e644ba1aef2999b9fd47103a15` |
| `reroll` | `ItemData.rerollAffixIDOfAffix` | `0x1212A10` | 1465 | `d70d73e0a024e5fee7be2dd7e8ae272a8eaf2fc1b0fb9fa10ca2d4888a443003` |

## 2. 完整数组的复核链

仅阅读类中的常量会得出错误的“五属性都例外”结论。当前 metadata 确实声明 `StrengthId=501`、`IntelligenceId=502`、`DexterityId=503`、`AttunementId=504`、`VitalityID=505`，但数组的真实值由当前静态构造器决定。[证据：`attributeInitializer` 与 metadata type definition 5809]

1. `CanForgeOnItem` 在 `0x11B16C2` 读取 TypeInfo slot `0x53169D0`。该 slot 当前编码 `0x20025581`，解析为 native type index 76480，再映射到 metadata type definition 5809：`SwapAttributesItemContainer`。
2. 失败回退读取这个类的 `static_fields` 首字段，即 `AttributeIds`。`IsAttribute(ushort)` 也读取同一字段。
3. 静态构造器 `0x1480631` 的 `mov edx,4` 明确分配 **4 个 UInt16**。数组 TypeInfo slot `0x534EE98` 解码为 `SZARRAY<System.UInt16>`。
4. `0x148063B` 加载 FieldInfo slot `0x53610D0`，其编码 `0x80000085` 指向 metadata **FieldRef 66**：type index 42500、relative field index 15。
5. FieldRef 66 的所属类型是 `<PrivateImplementationDetails>`（type definition 13553），实际全局 field index 95895，字段名 `2B9C8630165929EF9F830778B88C1252C5B3BD4A5CE6A88ACBD5A470EE31AE70`。
6. 其 field-default row 16151 指向 data index 51064，即 metadata 文件偏移 **`0x1190868`**。按数组长度读取 8 字节得到 **`f501 f601 f701 f801`**，小端 UInt16 为 **501、502、503、504**。
7. 这 8 字节的 SHA256 恰为 `2b9c8630165929ef9f830778b88c1252c5b3bd4a5ce6a88acbd5a470ee31ae70`，与编译器生成字段名相符。数组没有第五项，不能继续读相邻常量或额外填入 505。

因此完整成员已从当前原生分配长度与实际 initializer blob 共同确定；不是依靠常量名称、连续数字搜索或旧研究外推。[可复现脚本](../../scripts/extract_legacy_forge.py)会重新检查上述映射与编译器 blob 哈希。

| ID | 当前资源名称 | 当前 `classSpecificity` | 当前 `canRollOn` equipmentType 列表 | 在已有词缀回退数组中 |
|---:|---|---:|---|---|
| 501 | Strength | 11 | 0、1、3、21、4、22 | 是 |
| 502 | Intelligence | 21 | 0、1、3、21、4、22 | 是 |
| 503 | Dexterity | 0 | 0、1、3、21、4、22、17 | 是 |
| 504 | Attunement | 11 | 0、1、3、21、4、22 | 是 |
| 505 | Vitality | 0 | 0、1、3 | 否 |

这些行均为当前资源中的普通前缀：`type=0`、`specialAffixType=0`、`rollsOn=0`。资源资格与回退数组是两层事实；表内 `canRollOn` 不等于回退触发所允许的完整存量范围。[证据：当前 `affixes.json`，对应投影保存在结构化证据 `affixResourceProjection`]

## 3. 实际条件与可供 TypeScript 实现的接口

`CanForgeOnItem` 先在 `0x11B16B0` 调用 `CanRollOn`。成功立即返回 true；失败后，只有传入 `affixAlreadyOnItem=true` 才查询数组。它在 `0x11B16EA` 从所选 Affix 定义读取 UInt16 ID，再在 `0x11B16FD` 调用 `Contains`，命中才返回 true。泛型方法 metadata usage 也解析到 method definition 211138：`System.Linq.Enumerable.Contains`，所属 type definition 29535。[证据：`canForge`、`contains`]

```ts
// 只表示词缀与物品的制作兼容性；输入 ID 应已通过版本化词库校验。
const EXISTING_ATTRIBUTE_FORGE_OVERRIDE = new Set([501, 502, 503, 504]);

function canForgeAffixOnItem(affix: AffixDefinition, item: ItemState): boolean {
  return canRollOn(affix, item.baseType, item.subType, item.base.classRequirement)
    || (item.affixes.some(existing => existing.id === affix.id)
      && EXISTING_ATTRIBUTE_FORGE_OVERRIDE.has(affix.id));
}
```

`affixAlreadyOnItem` 不应由调用方任意填写。当前 `CheckForgeCapability` 在 `0x1167E48` 调用 `ItemData.hasAffix(selectedShardAffixId)`，把结果保存并作为参数传给 `0x1167E94` 的 `CanForgeOnItem`。随后在 `0x1167EAA` 另查 `hasAffixAsSealedAffix` 并拒绝封印对象。因此这个局部函数通过，并不代表封印词缀可以用普通碎片升级。[证据：`compatibilityCall`]

对合法枚举值，普通 `CanRollOn` 仍需同时满足：

- `MatchesSpecificity(actualBase.classRequirement, affix.classSpecificity)`。等价条件为 `req==31 || specificity==0 || (req==0 && (specificity&1)!=0) || (((req<<1)&specificity)!=0)`；使用底材要求，而不是玩家职业取代底材字段。
- `canRollOn` 包含实际 equipmentType，或满足神像 subtype group 的回退。equipmentType 29／30 且 subtype 为 10–14 或 17 时分别为 group 1／2；group 1 接受列表中的 31 或 33，group 2 接受 32 或 33；其余 group 为 0。

已有四属性的例外位于整个 `CanRollOn` 失败之后，因此可覆盖其中的职业或类型不匹配；它没有重新把例外限制在某一失败原因上。[证据：`canForge`、`canRoll`、`classMatch`、`subtypeGroup`、`subtypeCompatibility`]

| 普通资格 | 所选 ID 已存在 | ID 在四项数组中 | 本兼容性检查 |
|---|---|---|---|
| 通过 | 任意 | 任意 | 通过 |
| 失败 | 否 | 任意 | 拒绝 |
| 失败 | 是 | 是 | 通过 |
| 失败 | 是 | 否 | 拒绝 |

不得因此跳过完整动作的 FP、装备类别、玩家等级、封印、最高可制作阶数、前后缀容量或 glyph 资格检查。这里完整审阅的是 **O1 兼容性分支**；其他门槛继续使用[原子动作研究](affix-actions-audit.md)、[制作等级研究](crafting-level-requirements.md)与[Forge／FP 研究](forge-fp-audit.md)的独立证据。

## 4. 新增与重抽的边界

**新增 ID**：由于 `hasAffix` 为 false，例外数组不起作用。不能据此往当前不兼容底材新增力量、智力、敏捷或协调。输入已有这些存量词缀时，也不宜在顶层校验中仅因 `CanRollOn=false` 就统一否决其后续升级；应让原生对应的 `CanForgeOnItem` 规则参与具体动作资格。

**救赎／混沌候选**：当前 `rerollAffixIDOfAffix` 在 `0x1212D6B`、`0x1212E5D` 对两类资源集合直接调用 `CanRollOn`，未经过 `CanForgeOnItem`。因此四项例外不能扩大重抽池。候选仍须满足普通类型、相同前后缀侧、实际底材／职业资格及当前全 ID 集合排除等既有约束；源对象处理规则与候选规则仍需区分。[证据：`reroll`；完整候选规则见[原子动作研究第 5 节](affix-actions-audit.md#5-救赎与混沌的候选和权重)]

## 5. 复现与状态

研究脚本只用 Python 标准库，直接读取当前游戏与仓库内的版本化资源。它在解析前验证 DLL、metadata、当前 Steam build 和资源快照哈希；新游戏版本必须重新审计，不能只改输出版本号。

```powershell
python -X utf8 scripts/extract_legacy_forge.py
python -X utf8 scripts/extract_legacy_forge.py --verify-only
```

也可用 `--game-dir` 指定同一已审计版本的安装目录。第一次生成结构化证据；`--verify-only` 不写文件，重新提取后逐字节比较已提交 JSON，任何不一致返回非零。

本轮 fresh 提取及再次独立进程 `--verify-only` 通过：四项成员、10 段当前原生字节、metadata 初始化链及 12 个局部判断真值示例一致。真值示例是静态逻辑的参考展开，不冒充客户端执行测试。O1 所问完整数组成员与触发条件已解出；未声称完整制作器或全游戏兼容性已获客户端验证。
