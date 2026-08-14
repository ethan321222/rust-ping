

# Rust Ping 技术调研 & 路线选择记录

## 起点：Node.js 有 ping 方法吗？

Node.js **标准库没有** ping 方法。常见方案：

| 方案 | 原理 | 缺点 |
|------|------|------|
| `child_process.exec('ping ...')` | 调用系统命令 | 每次开进程，性能差 |
| npm `ping` (node-ping) | 封装系统 ping 命令 | 100 次 = 100 个进程 |
| npm `net-ping` | raw socket + ICMP | 需要管理员权限 |
| TCP 探活 | `net.Socket.connect()` | 不是真正的 ICMP ping |

---

## 参考项目：node-raw-socket

项目路径：`D:\work\node-raw-socket-master`

**不是调用系统 ping 命令**，而是用 C++ 实现了系统 ping 底层用的同一套 socket API（raw socket + ICMP），然后通过 N-API 桥接给 Node.js。

核心实现（`src/raw.cc`）：
- `socket(AF_INET, SOCK_RAW, IPPROTO_ICMP)` 创建原始套接字
- `sendto()` 发送手工构造的 ICMP Echo Request
- `recvfrom()` 接收 ICMP Echo Reply
- `uv_poll` 集成到 Node.js 事件循环（非阻塞）
- `node-addon-api`（N-API）暴露给 JS

---

## 参考项目：net-ping

`net-ping` 是 `node-raw-socket` 同一作者的上层封装。

### Session 是什么？

Session = **一个 ICMP socket + 请求状态管理器**

```
Session 内部持有：
├── 1 个 raw socket（通过 raw-socket C++ 插件创建）
├── sessionId（固定的 ICMP identifier，标识"这是我的包"）
├── nextSequence（自增计数器）
├── pending requests 表
│   ├── seq=1 → { callback, timer, retryCount, sentAt }
│   ├── seq=2 → { callback, timer, retryCount, sentAt }
│   └── ...
└── 配置（timeout, retries, ttl, packetSize）
```

### 关键问答

**Q: 100 次 pingHost 是启动 100 个进程吗？**
A: 不是。全部共用 1 个 socket，0 个额外进程。

**Q: 只构造了一份 socket 吗？**
A: 是。1 个 session = 1 个 socket。所有 pingHost 调用通过同一个 socket 发送和接收。

**Q: 每次构造一份新的 ICMP 包吗？**
A: 是。因为每个请求的 sequence number 不同（用于匹配回包），checksum 也要重算。
- **Socket**（通道）→ 只造 1 个，复用
- **ICMP 包**（数据）→ 每次新造 1 份

**Q: 连续 2 个 ping 是 2 个线程还是 1 个线程？**
A: **1 个线程**（Node.js 主线程）。全靠事件循环驱动：
- `sendto()` 对 ICMP 小包立即返回（非阻塞）
- `recvfrom()` 由 libuv `uv_poll` 通知"有数据了"才调用
- 没有额外线程参与 socket I/O

**Q: net-ping 是在 Node.js 主进程执行吗？**
A: 是。完全在主进程内、主线程上、通过事件循环驱动。不 spawn 任何子进程。

---

## 性能对比

| 调用 100 次 ping | net-ping | node-ping（spawn） |
|---|---|---|
| socket/进程数 | 1 个 socket | 100 个进程 |
| 文件描述符 | 1 个 fd | ~300 个 fd |
| 内存 | 几 KB | ~100MB |
| 启动延迟 | 无 | 每进程几十 ms |
| 最大并发 | 65535（seq 空间） | 受限于 OS 进程数 |

---

## 路线选择：Rust 绑定方案

**Q: C++ 用 N-API，Rust 该用什么？**
A: **napi-rs** — Rust 版 N-API 绑定，最优雅的方案。

| 对比 | C++ (node-addon-api) | Rust (napi-rs) |
|------|---------------------|----------------|
| 绑定方式 | 手写 N-API 类/方法注册 | `#[napi]` 宏自动导出 |
| 类型定义 | 手写 .d.ts | 自动生成 .d.ts |
| 构建系统 | node-gyp (binding.gyp) | @napi-rs/cli (Cargo) |
| 内存安全 | 手动管理 | Rust 所有权保证 |
| Bun 兼容 | ✓（N-API） | ✓（同样是 N-API） |
| 交叉编译 | 困难 | napi-rs 内置支持 |

napi-rs 示例（实际实现中的模式）：
```rust
#[napi(object)]
pub struct JsPingReply {
    pub addr: String,
    pub seq: u32,
    pub ttl: u32,
    pub time: f64,  // RTT in ms
    pub bytes: u32,
}

#[napi]
pub struct NativePingSession { /* ... */ }

#[napi]
impl NativePingSession {
    #[napi(constructor)]
    pub fn new(
        options: Option<JsSessionOptions>,
        on_reply: ThreadsafeFunction<JsPingReply>,
        on_timeout: ThreadsafeFunction<JsPingTimeout>,
        on_error: ThreadsafeFunction<JsPingError>,
    ) -> Result<Self> { /* ... */ }

    #[napi]
    pub fn send_ping(&self, target: String) -> Result<u32> { /* ... */ }
}
```

---

## Rust 实现的线程模型选择

### 背景：为什么 Rust 不能完全复制 net-ping 的模型？

net-ping（C++）的做法：
- C++ 直接访问 libuv 的 `uv_poll_t` API
- 把 socket fd 注册到 Node.js 事件循环
- 主线程在事件循环 tick 时自动收到"可读"通知，然后调用 recvfrom
- **结果：0 个额外线程，纯事件驱动**

Rust (napi-rs) 的限制：
- napi-rs **没有暴露 libuv poll API**（它封装的是 N-API，不是 libuv）
- 无法把 socket fd 注册到 Node.js 的事件循环中
- 因此无法在主线程里"被通知"socket 可读

### 方案对比

| | 方案 A: 集成 libuv 事件循环 | 方案 B: 独立 recv 线程 |
|--|--|--|
| **原理** | 把 socket fd 注册到 libuv poll，主线程事件循环驱动收包 | 单独开 1 个线程做 recvfrom 循环，通过 ThreadsafeFunction 回调 JS |
| **线程数** | 0 额外线程（和 net-ping 一样） | 1 个额外线程 |
| **实现难度** | 高 — 需要 unsafe 调用 libuv C API (`uv_poll_init_socket`)，绕过 napi-rs | 低 — napi-rs 标准模式，有官方示例 |
| **安全性** | 需要大量 unsafe，手动管理 libuv handle 生命周期 | 纯 safe Rust + Arc/Mutex |
| **性能** | 理论最优（零线程切换开销） | 极小开销（recv 线程 → ThreadsafeFunction → 主线程，一次跨线程通知） |
| **维护性** | 脆弱 — 依赖 libuv 内部 ABI，Node.js 大版本升级可能 break | 稳定 — 只依赖 N-API（ABI 稳定承诺） |
| **超时管理** | 依赖 libuv timer（又要手动绑定） | 自主管理（recv 超时后扫描 pending 表） |

### 为什么不能用事件循环？— 三条路线的深入分析

核心问题：**谁来驱动 recvfrom？** socket 上有回包时，谁来通知我们去读？

#### 路线 1：unsafe 直接调用 libuv（和 C++ 项目做法一样）

```rust
// 理论上可以在 Rust 里 unsafe 调用 libuv C API
extern "C" {
    fn uv_poll_init_socket(loop_: *mut uv_loop_t, handle: *mut uv_poll_t, socket: i32) -> i32;
    fn uv_poll_start(handle: *mut uv_poll_t, events: i32, cb: uv_poll_cb) -> i32;
}
```

**可行，但不该这么做：**
- 大量 unsafe，手动管理 libuv handle 生命周期
- 需要拿到 `uv_default_loop()` 指针（N-API 有 `napi_get_uv_event_loop`，但已标记 **deprecated**）
- **Bun 没有 libuv**（用 io_uring/kqueue），这条路在 Bun 上直接不工作
- 本质上是在 Rust 里写 C 风格代码，失去了 Rust 的安全优势
- libuv 内部 ABI 不稳定，Node.js 大版本升级可能 break

#### 路线 2：tokio AsyncFd

```rust
// 用 tokio 的异步 fd 包装 raw socket
let async_fd = AsyncFd::new(raw_socket)?;
loop {
    let mut guard = async_fd.readable().await?;
    // 非阻塞读取...
}
```

**问题：**
- `AsyncFd` 只支持 Linux/macOS（基于 epoll/kqueue），**Windows 不支持**
- tokio runtime 内部也开了线程池，并不是真正的"零线程"
- 引入完整 tokio 运行时增加二进制体积
- 需要和 napi-rs 的 tokio runtime 协调（避免两个 runtime 冲突）

#### 路线 3：1 个专用 recv 线程 ✓

```rust
std::thread::spawn(move || {
    loop {
        match socket.recv_from(&mut buf) {
            Ok((n, addr)) => { /* 匹配 seq，通过 tsfn 回调 JS */ }
            Err(timeout) => { /* 扫描 pending 表，处理超时 */ }
        }
    }
});
```

**为什么这是最优解：**

| 驱动方 | net-ping (C++) | Rust 路线 1 | Rust 路线 2 | Rust 路线 3 |
|--------|---------------|-------------|-------------|-------------|
| 机制 | libuv uv_poll | unsafe libuv FFI | tokio AsyncFd | std::thread |
| 额外线程 | 0 | 0 | tokio 线程池 | 1 |
| 跨平台 | ✓ | ✗ Bun 不行 | ✗ Windows 不行 | ✓ |
| 安全性 | C++ 手动管理 | 大量 unsafe | safe | safe |
| 维护性 | 依赖 libuv ABI | 依赖 libuv ABI | 依赖 tokio | 只依赖 std |
| 成本 | — | — | runtime 开销 | ~8KB 栈内存 |

**1 个线程的真实成本：**
- 内存：~8KB 栈（可配置）
- CPU：回包之间 recvfrom 阻塞在内核，**0 CPU 占用**
- 延迟：收到回包后通过 ThreadsafeFunction 通知主线程，一次 `uv_async_send` 原子操作，纳秒级

### 性能影响分析：多 1 个线程有影响吗？

**结论：几乎没有影响。**

多出来的开销（1 个 recv 线程 vs net-ping 的纯事件循环）：

| 开销项 | 量级 | 说明 |
|--------|------|------|
| 线程创建 | 一次性 ~0.1ms | session 创建时开，close 时销毁 |
| 栈内存 | ~8KB | 线程默认栈，实际用到的更少 |
| 跨线程通知 | ~几百纳秒/次 | `uv_async_send` 一次原子写 |
| CPU（空闲时） | 0 | recvfrom 阻塞在内核，不消耗 CPU |
| CPU（收包时） | 和 net-ping 一样 | 都是 recvfrom → 解析 → 回调 |

实际场景下的差异：

```
并发 ping 1000 个目标，每个目标 RTT ~10ms

net-ping (C++):   回包到达 → libuv poll 唤醒主线程 → 回调
Rust 方案:        回包到达 → recv 线程读取 → tsfn 通知主线程 → 回调
                                            ↑
                              多了这一步，~200-500ns
```

1000 个回包多花的时间：`1000 × 500ns = 0.5ms`，相对于总 RTT（~10000ms），可忽略。

**真正影响 ping 性能的因素：**
- socket 系统调用次数（我们和 net-ping 一样，1 次 sendto + 1 次 recvfrom per ping）
- 内核 ICMP 处理延迟（和线程无关）
- 网络本身的延迟（占 99.9% 的时间）

网络延迟是毫秒级，线程通知是纳秒级，差了 **6 个数量级**。多一个线程对 ping 场景的性能影响 ≈ 0。

### 最终方案确认

- **进程数：1**（就是 Node.js 自身，没有新进程）
- **线程数：2**（Node.js 主线程 + 1 个 Rust recv 线程）
- Rust 代码作为 `.node` 动态库加载到 Node.js 进程内，不是独立进程

```
Node.js 进程（唯一的进程）
│
├── 主线程（JS + 事件循环）
│   └── sendto() 发包（同步非阻塞，立即返回）
│
└── recv 线程（createSession 时创建，close 时销毁）
    └── recvfrom() 收包 → 匹配 seq → ThreadsafeFunction → 主线程回调
```

### 选择方案 B 的理由

1. **napi-rs 的设计哲学就是方案 B** — 官方文档、示例全部是 ThreadsafeFunction 模式
2. **性能损失可忽略** — 跨线程通知只是一次原子操作 + 一次 uv_async_send，纳秒级
3. **不依赖 libuv 内部** — N-API 承诺 ABI 稳定，不怕 Node.js 升级
4. **Bun 兼容** — Bun 不用 libuv（用的是 io_uring/kqueue），方案 A 在 Bun 上根本不工作
5. **超时/重试自主可控** — recv 线程自己管理时间，不依赖外部 timer

### 最终模型（实际实现）

```
Node.js 主线程                         Rust recv 线程
│                                      │
├─ JS: _sendOne(target)                │
│  → native.sendPing(target)           │
│    → Rust: 解析 IP / DNS             │
│    → 构造 ICMP 包 (EchoRequest)      │
│    → sendto(socket) 立即返回          │
│    → pending.insert(seq, PendingReq) │
│    → 返回 seq 给 JS                  │
│                                      │
│                                      ├─ loop {
│                                      │    recvfrom(socket, timeout=100ms)
│                                      │    if 收到包 → parse_echo_reply
│                                      │              → 匹配 identifier + seq
│                                      │              → callback(PingEvent::Reply)
│                                      │              → tsfn.call() → JS onReply
│                                      │    if 超时   → check_timeouts()
│                                      │              → 重试 or callback(PingEvent::Timeout)
│                                      │  }
│                                      │
│  ← onReply 触发                      │
│    → JS: _pending.delete(seq)        │
│    → resolve Promise                 │
```

**关键：sendPing 在主线程执行（同步非阻塞），recvfrom 在 recv 线程执行。**

回调链路：
1. Rust recv 线程收到回包 → 调用 `EventCallback`（一个闭包）
2. 闭包内通过 `ThreadsafeFunction.call()` 跨线程通知
3. JS 主线程的 `onReply`/`onTimeout`/`onError` 被触发
4. JS 层从 `_pending` Map 中取出对应的 Promise 并 resolve/reject

### 为什么只需要 1 个 recv 线程而不是 N 个？

- 一个 socket 在任一时刻只能有一个 recvfrom 调用
- 所有回包都从同一个 socket 进来，一个线程 loop 读取就够了
- 匹配逻辑（查 pending HashMap）是 O(1) 操作，不是瓶颈
- 即使并发 10000 个 ping，也只需要 1 个 recv 线程

---

## 关键设计决策汇总

| 决策 | 选择 | 原因 |
|------|------|------|
| 绑定方案 | napi-rs (v2) | 宏驱动、自动 .d.ts、内存安全 |
| Socket 复用 | 单 socket per session | 参考 net-ping，高性能 |
| 线程模型 | 主线程发送 + 1 recv 线程 | napi-rs 标准模式，跨平台 |
| 底层 socket | socket2 crate (v0.5) | 跨平台、安全、maintained |
| ICMP 包构造 | 手写（Rust） | 协议极简（8 字节头），无需外部库 |
| 异步回调 | ThreadsafeFunction（constructor 注入） | napi-rs 从非主线程回调 JS 的标准方式 |
| IPv4/IPv6 | IPv4 优先，预留 v6 | 降低首版复杂度 |
| API 风格 | Callback + Promise + Batch | 多种调用方式，适配不同场景 |
| Session 管理 | DefaultSession（懒加载 + keepAlive）+ createSession（手动管理） | 简单场景零配置，复杂场景可控 |

---

## 多路复用（Multiplexing）原理

### 什么是多路复用

多路复用 = **多个请求共享一个通道，通过标识符区分谁是谁的回包。**

这不是 rust-ping 发明的概念，它是网络编程中的基础模式：

| 场景 | 共享通道 | 标识符 | 解复用方式 |
|------|---------|--------|-----------|
| HTTP/2 | 1 个 TCP 连接 | Stream ID | 按 Stream ID 分发帧 |
| DNS | 1 个 UDP socket | Transaction ID | 按 ID 匹配响应 |
| **ICMP ping** | **1 个 ICMP socket** | **identifier + seq** | **按 seq 匹配 pending 表** |
| 传统 node-ping | 无复用 | 不需要 | 每个请求独立进程 |

### rust-ping 的多路复用实现

```
session.ping('8.8.8.8')  →  seq=1  ─┐
session.ping('1.1.1.1')  →  seq=2  ─┤
session.ping('9.9.9.9')  →  seq=3  ─┤   共享 1 个 ICMP socket
session.ping('baidu.com') → seq=4  ─┤   ↕ sendto / recvfrom
...100 个请求             → seq=N  ─┘
                                      │
                            ┌─────────▼──────────┐
                            │     网络 / 内核      │
                            └─────────┬──────────┘
                                      │
                                      ▼
                              recv 线程收到回包
                              解析 ICMP reply
                              取出 seq number
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
              seq=1 匹配          seq=3 匹配         seq=2 匹配
              resolve('8.8.8.8') resolve('9.9.9.9') resolve('1.1.1.1')
```

### 核心机制

**复用（发送侧）：**
- 所有 ping 请求通过同一个 socket 的 `sendto()` 发出
- 每个请求分配唯一的 sequence number（u16，0~65535）
- ICMP 包头中写入 `identifier`（session 级）+ `sequence`（请求级）

**解复用（接收侧）：**
- 1 个 recv 线程对同一个 socket 做 `recvfrom()` 循环
- 收到 ICMP reply 后，解析出 `identifier` + `sequence`
- 用 `sequence` 在 pending HashMap 中查找对应的 Promise（O(1)）
- 找到后 resolve，找不到就丢弃（可能是其他程序的 ping 回包）

### 为什么效率高

**并发 100 个 ping 的总耗时 ≈ 最慢的那一个，而非逐个累加：**

```
串行模式（无复用）：
  ping A (50ms) → ping B (45ms) → ping C (48ms) → ...
  总耗时 = 50 + 45 + 48 + ... = 所有 RTT 之和

多路复用模式：
  ping A ─────┐
  ping B ─────┤  同时发出，同时等待回包
  ping C ─────┤
  ...         │
  总耗时 = max(RTT_A, RTT_B, RTT_C, ...) ≈ 最慢的那个
```

实测验证（100 个并发 ping google.com）：

```
单次 RTT: ~47ms
串行 100 次理论耗时: 47ms × 100 = 4700ms
实际并发耗时: 73ms（≈ 最慢的那一个 + socket 调度开销）
加速比: 4700 / 73 ≈ 64x
```

### 与 HTTP/2 多路复用的类比

HTTP/2 之前，浏览器为了并行请求需要开 6 个 TCP 连接（HTTP/1.1 的做法）。HTTP/2 在 1 个连接上通过 Stream ID 复用，本质和我们完全一样：

```
HTTP/1.1 的做法（类似 node-ping）：
  请求 A → TCP 连接 1
  请求 B → TCP 连接 2    ← 每个请求独占一个连接
  请求 C → TCP 连接 3
  资源消耗：N 个连接

HTTP/2 的做法（类似 rust-ping）：
  请求 A (stream=1) ─┐
  请求 B (stream=2) ─┤→ 1 个 TCP 连接
  请求 C (stream=3) ─┘
  资源消耗：1 个连接，N 个 stream ID
```

### 并发上限

sequence number 是 u16（0~65535），所以理论上 1 个 session 最多同时有 65535 个 pending 请求。实际上远达不到这个上限 —— 网络带宽和目标主机会先成为瓶颈。

---

## 内存安全分析

### 正常使用：无泄露

每次 `await session.ping()` 完成后，JS 和 Rust 两层的内存都会正确释放：

**JS 层：**
- `_sendOne()` 时在 `_pending` Map 注册条目：`{ resolve, reject, target, host }`
- 收到回包/超时/错误时 `_pending.delete(seq)` 移除条目
- Promise resolve/reject 后，闭包和结果对象由 GC 回收

**Rust 层（ping-core::session）：**
- pending `HashMap<u16, PendingRequest>` 中的条目在 reply/timeout/error 时 `remove()`
- ICMP 包 buffer 是 recv 线程栈上分配的 `[0u8; 65535]`，每次循环复用
- PendingRequest 中的 `packet: Vec<u8>` 在 remove 时自动 drop
- 不存在手动 malloc/free，不可能忘记释放

**实测验证（10 轮 × 100 并发 = 1000 次 ping）：**

```
node --expose-gc example/07-memory-check.js

  第  1 轮: heap=3.81MB, pending=0
  第  2 轮: heap=3.81MB, pending=0
  第  3 轮: heap=3.81MB, pending=0
  ...
  第 10 轮: heap=3.90MB, pending=0
```

heap 波动 0.09MB（正常 GC 波动），pending 每轮归零，无泄露。

### 资源生命周期：session.close() 是必须的

`session.close()` 释放的资源：
- 1 个 ICMP socket（文件描述符）— `IcmpSocket` drop 时关闭
- 1 个 recv 线程（`running` 设为 false → 线程退出 → `JoinHandle::join()`）
- ThreadsafeFunction 引用（允许 GC 回收 JS 回调）

此外 `PingSession` 实现了 `Drop` trait，即使忘记显式调用 `close()`，Rust 析构时也会自动关闭。

**不调 close() 的后果：** socket 和 recv 线程会一直存在，直到进程退出。这不是 bug，是正常的资源管理模式 —— 和 Node.js 标准库一致：

```js
// Node.js 标准库同样需要显式关闭：
const server = net.createServer();   // 不 close → 端口占用
const fd = fs.openSync('file');      // 不 close → fd 泄露
const pool = mysql.createPool();     // 不 end  → 连接占用

// rust-ping 同理：
const session = createSession();     // 不 close → socket + 线程占用
```

**这是设计，不是缺陷。** 用户持有一个有状态的资源（socket），用完后主动释放，这是所有 I/O 资源的标准模式。如果自动释放（比如靠 GC finalizer），反而会导致不可预测的行为 —— 你不知道 socket 什么时候被关，pending 的请求什么时候会被中断。

### 防御性设计

即使用户忘记 close，也不会导致 pending 条目无限积累：
- 超时机制保证每个 pending 条目最终会被清理（timeout × (1 + retries) 后必定触发）
- 只有 socket 和线程本身需要 close 来释放
- 进程退出时 OS 会回收所有 fd 和线程（兜底）
