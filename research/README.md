# 研究复现

所有命令在本仓库根目录运行，Windows PowerShell。正式脚本不导入外层LE-filter，不需要旧.cache。原始游戏文件只在重新提取／打印原生指令时需要。

## 创建匹配环境

```powershell
py -3.11 -m venv .venv
.venv/Scripts/python.exe -X utf8 -m pip install -r research/requirements.lock.txt
.venv/Scripts/python.exe -X utf8 -m pip check
```

## 重新提取与只读比对

```powershell
.venv/Scripts/python.exe -X utf8 scripts/extract_game_snapshot.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch'
.venv/Scripts/python.exe -X utf8 scripts/extract_game_snapshot.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch' --verify-only
.venv/Scripts/python.exe -X utf8 scripts/inspect_native_method.py --game-dir 'C:/Program Files (x86)/Steam/steamapps/common/Last Epoch' --name '^ItemData::SetForgingPotential$'
```

当前审计基线锁定1.5.3/build26087601。安装不符即退出；常规提取不会自动改写基线来绕过校验。`register_audited_build.py`只用于明确审计新版本时的人工登记，必须提供显式build、日期和来自对应元数据的地址索引。登记当前字节不代表自动验证其语义；新增版本仍需新的行为审计。`additional-methods.json`保留主程序集索引之外的已审方法标签及字节指纹。

## 无游戏、离线验证

```powershell
py -3.11 -X utf8 scripts/validate_research.py
py -3.11 -X utf8 scripts/check_math_fixtures.py
py -3.11 -X utf8 scripts/check_action_examples.py
py -3.11 -X utf8 scripts/check_fp_examples.py --verify-only
py -3.11 -X utf8 -m unittest discover -s tests -v
```

这些检查读取本仓库已提交快照，使用标准库，不要求UnityPy、父项目、本地安装或网络。结构化清单使用数据哈希锁定版本；用完整本地安装执行`--verify-only`才是重新读取原始资源与DLL的证明。

## 数据与证据的角色

- `audited-build.json`：原始四文件指纹、版本及审计日。
- `native-methods.json`、`additional-methods.json`：地址与字节登记，不表示所有登记方法行为均审。
- `affix-action-claims.json`、`forge-fp-claims.json`：本轮具体原生行为、置信状态、方法引用与未决事项。
- `evidence-matrix.json`：两份审计的统一引用索引。
- `model-snapshot.json`：研究模型版本、数据修订、政策、随机假设与生产前缺口。
- `math-fixtures.json`：明确标注为合成的小模型，用于验证通用数学，绝不作为游戏机制。
- `fp-examples.json`：当前证据下的费用研究样例；其随机模型与完整产品求解器分开说明。
- `validation.json`：本轮实际执行的验证与范围，不替代客户端实测。

原始.dll/.bundle/.dat、虚拟环境与缓存由gitignore排除。BOOTSTRAP.md与原始附件哈希一致；本轮产品修订在PRD／架构文档中记录。
