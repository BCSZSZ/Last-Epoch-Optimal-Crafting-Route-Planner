# 实施计划与部署决策

## 当前执行范围

执行已批准的“GitHub 托管优先”计划首阶段：本地机制审计、结构化快照、可复现研究与数学架构。BOOTSTRAP 原文保持不变；本轮产品政策由 PRD 记录。研究文档审阅前不制作生产求解器或表面原型。

## 阶段与完成条件

| 阶段 | 交付与门槛 |
|---|---|
| Phase 0 | 11 份研究／架构文档、证据矩阵、当前快照、提取／验证脚本；审阅未知项、随机原语假设、规则和目标函数 |
| Phase 1 | 纯 TypeScript 状态／目标与原子规则；逐项通过证据核对和联合转移测试 |
| Phase 2 | 宏动作与吸收评价；在真实规则小场景下首次比较浏览器／Node 性能 |
| Phase 3 | 固定宏路线穷举基线与搜索；安全剪枝同完整小模型一致 |
| Phase 4 | 普通／血／冰的完整路线曲线、FP／材料分布与混合预算评分 |
| Phase 5 | 手算、独立 Monte Carlo、参考计算器适用案例、完整浏览器性能和取消验证 |
| Phase 6 | 中文 React 交互；仅使用统一异步规划接口，使用 Vite 构建 |
| Phase 7 | GitHub Actions 测试／构建／发布，静态线上验证与版本回归 |

FP 三类在 Phase 0 即共同审计和设计，不留到 Phase 4 才发现需要修改状态。必要封印与剥离政策失败在完整原生后处理后吸收，不能截掉暴击、退款等真实结果。

## 执行接口与浏览器可行性

React 管理输入和展示，求解器不依赖 React／DOM／Worker。首版只有浏览器执行 Adapter；需要服务端时再实现相同契约的 Node Adapter，不预先建设多套服务器。

Worker 数据加载一次，进度／结果只发送摘要；大分布留在计算模块。测量真实词缀池的双 T7 重排、稀有救赎、封印／剥离前置、三类 FP，以及复杂目标。记录时间、峰值内存、搜索规模、取消响应、结果版本和评价精度。普通电脑与低性能设备分别报告，不用玩具性能承诺真实全搜索速度。

搜索预算与内存限制公开；未完成不冒充全局最优。发现热点先改状态表示、重复计算和可证明剪枝，必要时评估局部 WebAssembly，不能通过悄悄删目标或尾部概率达标。

## 托管顺序与已授权公开

1. 默认当前仓库直接发布 GitHub Pages。Vite 设置仓库子路径，打包 Worker 和数据，发布完整同版本静态产物。
2. 部署时核对账户资格。若私有仓库不支持 Pages，用户已授权把本仓库改为 public，无需再次请求公开许可。当前未启用 Pages 的 404 不能单独证明账户不具资格。
3. 仅当数学架构确认生产需要 Python，且 Community Cloud 的资源／并发验证通过时选择 Streamlit。研究脚本为 Python 不构成必须采用 Streamlit 的理由。
4. 若保持 TypeScript 而客户端算力不够，使用用户 AWS 承载同一求解器并保留 React。仅更换静态托管时复用原构建产物；增加远端计算时补执行 Adapter，避免两套生产规则。

网页面向所有玩家公开，无需登录。私有源码并不能隐藏浏览器下载的计算代码／静态数据。游戏原始二进制、本机缓存与凭据不发布。

## 官方部署参考

- [GitHub Pages 的仓库资格与静态托管性质](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Vite 静态发布与 Pages 子路径配置](https://vite.dev/guide/static-deploy.html#github-pages)
- [Streamlit 客户端／服务器架构](https://docs.streamlit.io/develop/concepts/architecture/architecture)
- [Community Cloud 资源与休眠](https://docs.streamlit.io/deploy/streamlit-community-cloud/manage-your-app)

以上为 2026-11-03 核对的托管事实，不能替代游戏机制证据。首次产品部署前重新核对资格与限制。
