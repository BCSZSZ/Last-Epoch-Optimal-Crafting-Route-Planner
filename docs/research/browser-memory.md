# 实际浏览器与Worker内存测量

2026-11-03，Chrome156／Windows，同一台i5-13600KF、32GiB工作站。运行模型`le-1.5.3-iid-f58515921fd9cbcc`。不是Node RSS、页面包大小或整台桌面占用。

## 方法与范围

使用[Measure Memory规范](https://wicg.github.io/performance-measure-memory/)及[接口说明](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)中的`performance.measureUserAgentSpecificMemory()`，保留完整breakdown／attribution。该接口需要安全上下文及cross-origin isolation；本地研究服务器只绑定127.0.0.1，对正式构建增加COOP／COEP头和独立观测面板。实际主JS、CSS、Worker字节保持不变；不修改主网页的线上响应头。

观测面板只测量，不自动操作游戏或驱动产品界面。通过真实界面启动同一个生产Worker；内存API可能触发回收并影响计时，所以带观测器耗时不与无观测器基准混作平台速度比较。Worker仅计恰有一个归属且scope为DedicatedWorkerGlobalScope的entry；共享／未归属部分保留在原记录，不能强行算作Worker。

## 已完成案例

固定7710直接准备、普通FP、1–63等权，最多60秒／500候选／12宏阶段／25000状态。正式Worker先有一次默认48候选热身，再清空观测记录并开始压力搜索。

- 完整规划比较500候选，用时14.404秒，主路线与默认案例相同；整条RouteReport与Node逐字段一致。
- 11个完成的原生样本，其中4个时间段覆盖规划；应用总量采样最大28.7996MiB，Worker单独归属采样最大19.8772MiB。
- 最大值是观测到的回收后估计，不是采样之间的瞬时分配峰值；不对不同浏览器版本作直接数值比较，也不声称低性能设备实测。

[原始内存记录](../../research/browser-memory/7710-normal-memory.json)、[确切输入](../../research/browser-memory/7710-normal-input.json)、[对应规划报告](../../research/browser-memory/7710-normal-plan.json)及[机器验证](../../research/browser-memory/validation.json)均保存。

## 复现

以仓库子路径构建后，运行`python scripts/serve_browser_memory.py`，打开`http://127.0.0.1:4175/app/`。载入同一输入，先“开始内存采样”再“开始规划”；停止后等待正在进行的测量完成，再导出记录。检查命令`python scripts/check_browser_memory.py --write-report`；线上构建更新后附加`--require-live-match`核对JS／CSS／Worker哈希。

该测量补齐浏览器实际内存证据。物理低性能电脑／手机仍需另测；原计划的设备覆盖尚不能标完成。
