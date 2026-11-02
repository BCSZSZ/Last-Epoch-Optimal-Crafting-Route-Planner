# 版本化词缀与底材数据库

## 本轮真实提取

2026-11-03 从本机游戏重新提取 `PermaLoad.bundle` 的 `MasterAffixesList`、`MasterItemsList`，并从 `globalgamemanagers/PlayerSettings` 读取版本。原始输入及方法字节哈希见[安装基线](../research/audited-build.json)、[快照清单](../data/game/1.5.3/manifest.json)。

完整保留 616 个 singleAffixes 与 540 个 multiAffixes，共 1156 个唯一词缀；42 类资源类型、923 个底材定义。其中资源编号 0–24 的 23 个非空普通装备类型含 565 个底材，包含旧版或不可掉落条目；不能将该数量当当前可掉落／可制作名单。

特殊类别原值数量为：0→770、1→12、2→26、3→61、4→49、5→66、6→134、7→38。保留原值，不根据名字把未知类别猜作普通。所有定义包括底材专属权重、职业条件、tiers、roll 与多属性字段；保留来源数组及原序号。

JSON中超出JavaScript安全整数范围的Unity对象标识以十进制字符串编码，避免后续浏览器解析时损失精度；普通词缀／底材ID仍为数值。该编码不改变原资源对象字节哈希。

## 文件与证据

- [affixes.json](../data/game/1.5.3/affixes.json)：每个 ID 的完整提取定义。
- [items.json](../data/game/1.5.3/items.json)：类型定义及使用复合 ID 的底材，保留需求、职业、腐化／旧版标志和 implicits。
- [resource-parameters.json](../data/game/1.5.3/resource-parameters.json)：冰保留与血额外暴击的原生 float32 参数。它们不是任意制作的无条件最终概率。
- [native-evidence.json](../data/game/1.5.3/native-evidence.json)：方法地址、长度、实际字节哈希和文件偏移。登记数量不代表每个方法都完成行为审计。

## 资格与权重

候选资格依据当前原生 CanRollOn、职业匹配、前后缀、特殊类别及已有 ID 排除。普通装备不能套用全部 1156 ID。SubTypeGroup 存在独立映射，不能无声删除神像相关范围，也不能将它们混为普通装备资格。

自然掉落权重、制作重抽权重与地面碎片权重分别处理。制作读取部位实际覆盖权重，小于 1 的权重执行已核实的制作变换；不能直接取全局默认 weighting，也不能把重抽身份当均匀抽取。救赎逐条更新完整已有 ID 集合，详情见[词缀动作审计](research/affix-actions-audit.md)。

## 提取与更新

运行 `scripts/extract_game_snapshot.py` 时先核对固定 build 和四份原始文件哈希；不符即退出，禁止自动给旧模型改版本标签。版本更新须显式登记新审计基线，再审阅方法与资源差异。

`--verify-only` 重新解析本地安装，在内存生成输出并逐字节比对，不改快照。常规提取不依赖父项目、旧缓存或网络。研究工具依赖锁在 [requirements.lock.txt](../research/requirements.lock.txt)。实际资源文件与游戏二进制不进入仓库。

当前快照是完整研究数据，不是已经实现并验证的生产候选池编译器。后续可按明确用途投影更小运行数据，但保留完整证据与版本联系。
