# 设备验证页

[打开验证页](https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/device-check/)。无需登录；计算和记录留在当前浏览器，不会自动上传。

填写可选设备型号和测试者声明的设备类别，选择完整矩阵，点击“开始设备验证”。请保持页面在前台。完整模式覆盖双T7重排、7710封印补词、7713浩劫准备、剥离后补词、稀有目标救赎各三类潜能，共15例。快速模式只跑五例普通潜能。两种模式均使用公开假设预算F1–63等权，每例默认12秒、48候选、12宏阶段、25000状态。

运行时可以取消，已完成案例保留。结束后下载完整JSON，或复制简短摘要。完整记录包含实际请求、整个PlanReport、适配器耗时、规划器内部耗时、浏览器公开设备提示、页面可见性变化及模型版本。设备类别仅为测试者声明，脚本不能据此证明物理硬件身份。首次适配器耗时包含Worker启动和加载，后续复用同一Worker；页面本身的下载／加载不计入按钮触发后的耗时。

“矩阵已完成”只表示所有规划请求均返回；各行另列搜索是否完成、候选覆盖和评价精度。墙钟限制可以改变候选覆盖，不承诺两台设备推荐相同；已选同一路线的完整数值报告另行交叉验证。

## 记录复核

在同一模型的仓库中运行：

```powershell
npx tsx scripts/check_device_benchmark.ts path/to/last-epoch-device-validation.json --output path/to/validation.json
```

检查器核对矩阵顺序、完整输入和模型，用Node重算每条主推荐，比较全部RouteReport字段。数值容差为绝对1e-14＋相对1e-12，并单独报告是否逐位一致。它不重新证明墙钟截断的搜索最优性，也不代替独立Python机制验证。未完成记录默认拒绝；显式使用`--allow-partial`只能验证已完成子集，不能作为完整矩阵验收。

此页不记录Worker内存用量；`reportedDeviceMemoryGiB`是浏览器给出的硬件容量提示。[原生浏览器内存观测](research/browser-memory.md)使用独立观测方法。

## 当前桌面基线

2026-11-03，i5-13600KF／32GiB、Windows、Chromium156，完整十五例始终在前台执行。[完整记录](../research/device-validation/desktop-baseline.json)与[Node复核](../research/device-validation/desktop-baseline-validation.json)保留全部输入及结果，十五条主推荐的整个RouteReport逐字段、逐位一致；适配器耗时0.294–7.820秒。所有例子均在已报告范围内未穷尽搜索，未证明最优。运行前另核对取消后状态为CANCELLED、可重新开始；摘要复制成功。390×844视口下页面实际可用宽341px，文档scrollWidth同为341px；临时视口已恢复。

该基线复用生产BrowserPlanner，诊断入口独立构建，主应用及生产Worker字节保持。诊断入口包含自己的资源副本，其首次加载大小独立于主应用；本次计时未覆盖慢网络下载。

同日Pages公网再运行五例普通潜能，全部在前台完成，[导出记录](../research/device-validation/public-normal.json)及[Node复核](../research/device-validation/public-normal-validation.json)保留；五条完整路线报告逐位一致，浏览器error日志为空。包括诊断入口在内的八个静态文件均通过[HTTP字节校验](../research/static-deployment.json)。设备验证页的[首次部署](https://github.com/BCSZSZ/Last-Epoch-Optimal-Crafting-Route-Planner/actions/runs/41584735545)成功，对应提交5dec1515d73bedda132798def99d4a4d8bd66a68。

## 待验收范围

2026-11-03用户确认目前没有低性能电脑或手机用于验证，**保留物理低性能设备待验收项**。当前桌面基线、禁JIT代理和窄屏布局检查都不替代该项；公开预览可使用，完整设备覆盖验收仍未通过。
