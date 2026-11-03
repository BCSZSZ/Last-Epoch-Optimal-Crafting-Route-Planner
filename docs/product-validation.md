# 产品、浏览器及性能验收

2026-11-03，运行模型`le-1.5.3-iid-f58515921fd9cbcc`。本文件区分自动回归、实际浏览器观察、独立概率验证与设备局限，不报告客户端打造实测。

## 正确性与接口

69项TypeScript测试覆盖原子联合规则、封印／剥离失败后的后续次数为零、FP边界、浩劫闭环、独立Python7710／771x数表与救赎参考、目标不可达／非法输入、有限小语言穷举对照、保护约束、取消、任务替换及旧消息隔离。30项Python完整性回归及全量研究验证另保留。

原子／已知路线的独立验证工具不导入TypeScript产品内核。资源、当前方法字节哈希、独立Fraction及研究Monte Carlo均由`validate_research.py`复核。浏览器／Node对照复用生产规则，是平台一致性检查，不能代替独立概率检查。

## 实际浏览器

使用本机ChatGPT in-app Chromium浏览器访问Vite正式构建预览及公开Pages站点。新版[七份完整报告及逐字段对照](../research/browser-validation/parity.json)包含本地正式构建、公网及内存压力搜索：

| 输入 | 潜能 | 加权J | 浏览器耗时 | 精度 |
|---|---|---:|---:|---|
| 7710直接准备 | 普通 | 44.7225% | 7.812s | 向外舍入区间 |
| 7713先浩劫准备 | 冰 | 41.8193% | 1.073s | 向外舍入区间 |
| 7717已有A | 血 | 83.2412% | 7.802s | 向外舍入区间 |
| 7732全部非目标 | 普通 | 4.3449% | 2.606s | 每F1024条、共64512条路径采样 |
| 剥离后补词 | 普通 | 11.3968% | 0.338s | 向外舍入区间 |
| 7710内存压力搜索 | 普通 | 44.7225% | 14.404s | 60秒／500候选，含内存观测开销 |
| 新版公网7710直接准备 | 普通 | 44.7225% | 7.836s | 向外舍入区间 |

表中为同一具体底材／ID／顺序的候选推荐，不是所有同tier串物品的统一概率，亦未证明全局最优。Node重算同一选中路线后，完整RouteReport的JSON逐字段一致，含采样曲线与种子。命令：`npx tsx scripts/check-browser-reports.ts`。

本轮新增到达／实际执行事件、每阶段净FP和到达后条件均值。T2封印剩1FP手算区分“到达后因FP不足停止”和“实际制作”；六组7710完整曲线检验各阶段无条件FP之和等于总期望。采样初筛及细化按最多2×候选数分配错误预算，界面展示一次规划99%联合统计区间。另已补齐[适用公开计算器回归](research/reference-calculators.md)：32封印格、三类FP费用PMF／CDF、三组浩劫布局。

实际UI额外核对：长任务取消后恢复；取消后切换冰潜能重新计算；计算中编辑角色等级使旧任务终止并清空旧结果；有效JSON导入；含inventory未知字段的输入拒绝且原输入保留；自定义F1–3权重[0,0,1]正确展示；输入保存后刷新恢复；下载报告；无浏览器error日志。

390×844视口覆盖窄屏布局检查，实际CSS可用宽341px，修复后document scrollWidth与clientWidth均为341px，横向无溢出。此项验证布局，不声称手机CPU性能。本轮375px实际可用宽度下，新版结果scrollWidth与clientWidth均375px；恢复后默认宽1265px。临时视口已恢复。

## 完整规划性能

[普通Node基准](../research/full-planner-node.json)和[禁JIT基准](../research/full-planner-node-jitless.json)分别测试五类真实输入×三类FP：双T7重排、7710、7713准备、剥离后补词、稀有目标救赎。每组在独立冷进程调用完整`plan`，包含候选生成、评价、排序及采样细化。默认12秒、48候选、12阶段、25000状态，记录实际覆盖、状态数、统计精度和进程峰值RSS。

环境为i5-13600KF／32GiB、Windows x64、Node22.20.0。普通计算段0.220–7.831秒，最大峰值RSS约195.0MiB；禁JIT0.982–12.032秒，最大峰值RSS约127.8MiB。模块导入和进程启动不计入耗时，RSS包含运行时；无其他基准计算并行执行。命令：`npx tsx scripts/planner-benchmark.ts`及附加`--jitless`。

禁JIT是受限数值运行条件代理，没有把它写成真实低性能硬件或浏览器CPU节流。部分稀有救赎用完时间后保留初筛统计区间；同一固定路线评价可复现，墙钟截断的候选覆盖和细化程度允许不同。本轮已通过[本地隔离原生内存观测](research/browser-memory.md)取得11个实际样本，包含Worker单独归属；采样最大值为应用合计28.80MiB／Worker19.88MiB。这个估计受GC影响，不等于瞬时分配峰值；没有用Node RSS冒充。物理低性能设备仍需补测。

构建主包约1.18MB、Worker约0.96MB（未压缩，均包含相同版本的冻结资源投影）；主包gzip约158KB。完整库与规则随构建绑定，静态计算不需要服务端、账号、游戏原始DLL或网络词库。

新增[设备验证页](device-validation.md)，完整十五例桌面浏览器矩阵始终在前台，适配器耗时0.294–7.820秒。十五条主推荐与Node完整报告逐位一致；这是所选路线的平台一致性，不是墙钟受限搜索覆盖相同的保证。已核对取消、重跑、摘要复制、完整导出和窄屏无页面溢出。2026-11-03用户确认暂无低性能设备，保留待验收项。

## 静态发布

工作流使用Vite仓库子路径和ES模块Worker，只发布dist。仓库代码／研究资料与必要派生数据已按用户授权公开，原始DLL、缓存、凭据和虚拟环境排除。私有Pages创建实际返回422套餐不支持，因此按已有授权将同一仓库改public，随后成功启用workflow发布。

公开地址：[制作路线规划](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/)。[首次构建／部署运行](https://github.com/BCSZSZ/Last-Epoch-Optimal-Crafting-Route-Planner/actions/runs/41576011780)成功，代码提交deaaac730d199a95edf91d7461e123dba88b252a。无登录访问后实际完成7710整路线规划；结果与本地逐字段一致。已核刷新、取消、重新规划、报告下载；error日志为空。

[HTTP字节验证](../research/static-deployment.json)对HTML、主JS、CSS、Worker逐一核对200、MIME与SHA256，全部与本地仓库子路径正式构建相同。复现命令：以`PAGES_BASE=/Last-Epoch-Optimal-Crafting-Route-Planner/`构建，再运行`python scripts/check_static_site.py https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/`。本地子路径预览也须向`npm run preview`传相同`--base`。

本轮报告增强提交f69c41abdbbc811a7d713614b3d89657a78565d7的[构建／部署](https://github.com/BCSZSZ/Last-Epoch-Optimal-Crafting-Route-Planner/actions/runs/41581627444)通过。公开版本模型为le-1.5.3-iid-f58515921fd9cbcc；新版公网完整报告与Node一致。内存记录已用`--require-live-match`检查，线上JS／CSS／Worker哈希与观测时一致。
