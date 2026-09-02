# 让 agent 常驻 WSL、UI 薄客户端 —— DSH 改造清单

> 目标：复刻 `.vscode-server` / `.zcode` 的 client/server 分体 —— 真正的 agent/执行进程**跑在 WSL 里的一个 Linux 常驻 server 内**，Windows 端只做 UI 薄客户端。本文只做**精确到包/函数的改造面分析**（source-grounded），不含实现。

**一句话结论（比之前的判断乐观）：** DSH 的 UI↔agent 本来就不是进程内硬耦合，而是一条**已经抽象好的协议/网关边界**。要做 origin-server，不是"重写核心"，而是**在边界上新增一种"远端 agent 后端"** + **把会话/执行机挂到 WSL**。真正要动的核心是有限的，且有一半是"利用已有 seam"而非"新造"。

---

## 0. 现状拓扑（源码证据）

```
[浏览器 UI]
   └─ 无数 @deepseek-ai/dsh-client-ui-* 包        ← 纯展示/交互
        └─ 依赖 @deepseek-ai/dsh-api-remotes      ← 远端调用生成层（typert remote-client）
             └─ @deepseek-ai/dsh-api-gateway       ← 传输抽象：WebSocket mux OR 本地 Host transport
                  └─ @deepseek-ai/dsh-api-session-controller / workspace-controller / ...   ← "controller" 服务
                       └─ @deepseek-ai/dsh-workspace（ctx.workspaceRegistry）
                            └─ 进程内 agent 组合（dsh-app-boot boot() 挂的 Loader/fiber）
```

**关键证据（我逐条在 node_modules 核过）：**

| 证据 | 位置 | 含义 |
|---|---|---|
| 内置了 `@agentclientprotocol/sdk`（ACP v2，session/new、session/prompt、session/cancel、session/update、tool-call 权限……） | `@deepseek-ai/dsh/node_modules/@agentclientprotocol/sdk` | DSH 采纳了**标准"客户端↔agent"协议**，UI 与 agent 的语义边界是标准化的 |
| Gateway 有两种传输模式：`RemoteStreamMuxServer`（WebSocket）和"**local Host transport**"；有心跳、`handleUpgrade` | `@deepseek-ai/dsh-api-gateway/lib/index.js` / `types/stream-server.js` | **传输层已经是可替换的**——不只是进程内 call |
| remote event 按 `agentId` 打包，`typert.contexts.getClient("agent")`、`typert.remotes.register` | `dsh-api-gateway/lib/index.js` / `client/remote-events.js` | 已经有"agent 是一个可按 id 寻址的远端身份"的模型 |
| `dsh-api-remotes/client.js` 是一整份 typert 生成代码，把 `client-ui-*` 的方法绑定到 controller 服务上（`remoteExport*`），并声明 service 如 `sessionController`/`workspaceController` | `@deepseek-ai/dsh-api-remotes/lib/client.js` | UI→controller 的调用**不是直接拿 service**，而是走网关的 remote 导出/绑定 |
| `sessionController` 暴露 `session/create|prompt|cancel|list|page|fork|rename|...`；`workspaceController` 管路径 | `dsh-api-remotes` 生成段 / `dsh-client-ui-*` 依赖 | 会话/工作区的"控制面"已集中在 controller 层 |

**推论：** UI 不直接访问宿主的 `ctx` 或 agent fiber。它访问的是"controller 服务"这一层，而这一层经 Gateway 传输。因此——**"agent 在别处运行"在语义上不是异端，只是目前缺少一种"远端 agent 组合"的接线。** 这正是 `.zcode` 能做成、而 DSH 也具备承接基础的原因。

---

## 1. 要做成 origin-server，缺什么（功能缺口）

把"agent 常驻在 WSL"拆成四个现实缺口：

1. **远端 agent 后端本体**：一个能跑在 Linux/WSL 的进程，加载 DSH 的 agent 组合（`dsh-agent-presets` / 会话 fiber），对外接受 ACP 会话。目前 host 只在**一个 Windows 进程**里 `boot()` 一次挂 Loader，没有"把 agent 组合单独进程化再连回"的先决路径。
2. **接线器（server 注册到 Gateway）**：这个 WSL 内 agent 如何作为 `agentId` 身份注册进 Windows 宿主 Gateway，让 controller 把 `session/prompt` 等转发给它、再把 `session/update` 流送回 UI。
3. **文件/工作区底座在 Linux**：`ctx.workspaceRegistry`、fs 工具、沙箱目前都以 **Windows 路径/Windows 沙箱**为底座。WSL 内 agent 需要 Linux 底座（或对 `\\wsl.localhost\...` 的 UNC→Linux 语义的完整支持）。
4. **`ctx.shell` / 执行机位置**：这是已反复确认的硬 seam。origin-server 真正价值就是**让执行机在 Linux 本地**——于是 `tool-wsl`、UNC 桥、跨系统 marshalling 全部消失。

---

## 2. 改造清单（精确到包/函数）

### 2A. 很可能**不需要动**的部分（复用现有 seam）

| 包 | 为什么可能不用动 |
|---|---|
| `@deepseek-ai/dsh-client-ui-*`（全部） | 它们只消费 `dsh-api-remotes` 暴露的 controller API，**不知道、也不关心** agent 在哪个进程。 |
| `@deepseek-ai/dsh-api-remotes` | 已是从 controller 服务生成 remote-client 的层；若远端 agent 仍走 `sessionController` 语义，这里基本零改动。 |
| `@deepseek-ai/dsh-workspace`（`ctx.workspaceRegistry`） | 只要能解析 WSL 路径（你已用 `realpathNormalize` + UNC 注册过 WSL 工作区），可保留为"注册中心"。 |
| `@deepseek-ai/dsh-api-gateway` 的 `RemoteStreamMuxServer` | 已有 WebSocket 传输、按 `agentId` 寻址实体身份的能力——**这是接入远端 agent 的现成连接点**。 |

### 2B. 需要**新增**的部分（核心改动，新组件，不破坏现有）

| 组件 | 放哪 | 职责 |
|---|---|---|
| **remote agent launcher** | 新包，装在 WSL，由你的插件经 `wsl.exe` 拉起 | 在 Linux 里 boot 一个 DSH agent 组合（复用 `dsh-app-boot` 的 Loader/预设），监听 ACP + Gateway 端口 |
| **agent transport connector**（Windows 侧） | 你的 `@crack/dsh-wsl` 插件新增 host 行，或独立小包 | 生成/握手 TLS（对照 `.zcode/v2/certs`）、把 WSL server 注册为 Gateway 里一个 `agentId`、建立 WS 反向连接回宿主 |
| **controller → remote agent 路由** | `dsh-api-gateway`（或 `dsh-api-session-controller`）加一种 backend 类型 | 让 `sessionController` 对"远端 agent"把 `session/prompt`/`update` 转发到该 `agentId`，而非进程内 fiber。**这是唯一必须触碰 DSH 官方核心的点** |
| **Linux 模式的文件/沙箱底座** | `dsh-tool-bash(+sandbox)` 的 Linux 变体或你自己的消费者 | 在 WSL server 内提供 Linux 的确切 `ctx.shell` 与 fs 工具，绕开 Windows 沙箱 |
| **workspace path 语义** | `dsh-workspace` / 你的注册后端 | 把"Windows 视角的 `\\wsl.localhost\...`"与"Linux 视角的 `/home/crack/...`"映射统一 |

### 2C. 最有把握的"最小可跑切面"（P0）

对照上面，门槛最低的一条龙：

1. WSL 内起一个静态打包的 node + 你的 agent 组合（shadow `.zcode/server/zcode-server.cjs`）。
2. 插件用 `wsl.exe` 拉起它，做一次 TLS 握手，把它**导入 `dsh-api-gateway` 的远端 `agentId`（接口已存在）**。
3. controller 加一个 if：该会话挂的是远端 agent → 走 `RemoteStreamMuxServer` 转发。
4. UI 端无需改动 → 一个"操作上像本地、执行在 WSL"的会话。

---

## 3. 必须明确的决策点（直接把控方案的选择）

| # | 未决问题 | 影响 |
|---|---|---|
| D1 | **远端 agent 跑完整 DSH 组合，还是只跑"执行机"（shell+fs+检索）？** | 前者 = `.zcode` 全模型（模型循环也在 Linux）；后者 = 只把命令/文件落到 Linux，循环仍在 Windows。后者改动面小一个量级。 |
| D2 | 模型推理（LLM 调用）放哪？ | 若只"执行在 WSL"，LLM 留在 Windows 宿主最省事。 |
| D3 | Windows 沙箱 vs Linux 本地无沙箱 | origin-server 意味着放弃 Windows ACL 沙箱换 Linux 原生（取舍，见前面讨论）。 |
| D4 | ACP 协议层要不要给远端 agent 用 | 若复用，等于"标准定义好了，只差接线"；若不用，走私有 RPC 更省但要自维护协议。 |
| D5 | 是否需要跨主版本兼容 | `extends ShellExecutor`、改 controller 这种，都会随官方主版本收紧；需锁定做法或提交 upstream。 |

---

## 4. 结论 / 建议路线

- **不需要**大改或重写 DSH 全部核心。UI、remote-client、workspace registry、WebSocket gateway**都是现成的**，且 UI↔agent 本就是协议边界。
- **必须动 DSH 官方的只有一处核心**：让 `sessionController` 能把会话挂到一个**远端 `agentId` backend**（2B 的第 3 项）。这是"把 agent 移出进程"与"留在进程"的真正的分水岭。
- D1 是关键取舍：**"执行在 WSL"（小改动，立即可用）** vs **"完整 agent 在 WSL"（`.zcode` 全模型，改动大一个量级）**。

**建议先做 D1=“执行机在 LSL”**：Windows 保留循环，WSL 内跑一个 Linux 底座（真 `ctx.shell` + fs + pty），Windows↔Linux 用已有 Gateway/ACP 接线。这一版就是"用尽量少的 DSH 核心改动，把工程最痛的那部分（每次 `wsl.exe`、UNC、沙箱、marshalling）整块挪进 Linux"。