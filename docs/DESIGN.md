# Rust Ping for Node.js/Bun — 设计文档

## 概述

用 Rust (napi-rs) 实现一个专注于 ping 的高性能原生模块。

- 单 socket 多路复用，100 次并发 ping 共享 1 个 socket
- 提供三种调用方式：Callback / Promise / Batch
- 跨平台：Windows + Linux + macOS
- IPv4 优先，预留 IPv6 扩展

---

## API 设计

```typescript
import { session, createSession } from 'rust-ping'

// ═══════════════════════════════════════════════
// 1. 默认 Session（懒加载，空闲自动关闭）
// ═══════════════════════════════════════════════
// 直接使用，无需手动创建/关闭
const result = await session.ping('8.8.8.8')

// 可选配置（仅在 session 未激活时可调用）
session.setConfig({ timeout: 5000, retries: 2, keepAlive: 30000 })

// ═══════════════════════════════════════════════
// 2. 自定义 Session（手动管理生命周期）
// ═══════════════════════════════════════════════
const custom = createSession({
  timeout: 2000,      // 单次超时 ms
  retries: 1,         // 超时重试次数
  ttl: 128,
  packetSize: 64,     // payload 大小(bytes)
})

// ═══════════════════════════════════════════════
// 3. Callback 风格（兼容 net-ping）
// ═══════════════════════════════════════════════
custom.pingHost('8.8.8.8', (error, target, sent, rcvd) => {
  if (error) console.log(`${target}: ${error.message}`)
  else console.log(`${target}: ${rcvd - sent}ms`)
})

// ═══════════════════════════════════════════════
// 4. Promise 风格（现代 async/await）
// ═══════════════════════════════════════════════
// 单次
const result2 = await custom.ping('8.8.8.8')
// { host: '8.8.8.8', addr: '8.8.8.8', alive: true, time: 12.5, ttl: 64, bytes: 72, seq: 1 }

// 多次（带统计）
const stats = await custom.ping('8.8.8.8', { count: 4 })
// { host: '8.8.8.8', alive: true, min: 10.2, max: 15.1, avg: 12.3, packetLoss: 0, replies: [...], errors: [...] }

// ═══════════════════════════════════════════════
// 5. Batch 风格（并发多目标）
// ═══════════════════════════════════════════════
const results = await custom.pingBatch(
  ['8.8.8.8', '1.1.1.1', '114.114.114.114'],
  { count: 1 }
)
// Map<string, PingResult | PingFailResult>

// ═══════════════════════════════════════════════
// 6. Session 事件
// ═══════════════════════════════════════════════
custom.on('close', () => { /* socket 已关闭 */ })

// ═══════════════════════════════════════════════
// 7. 关闭
// ═══════════════════════════════════════════════
custom.close()
```

---

## TypeScript 类型定义

```typescript
export interface SessionOptions {
  timeout?: number                   // 默认 2000ms
  retries?: number                   // 默认 1
  ttl?: number                       // 默认 128
  packetSize?: number                // 默认 64
}

export interface DefaultSessionConfig {
  timeout?: number                   // 默认 2000ms
  retries?: number                   // 默认 1
  keepAlive?: number                 // 空闲存活时间(ms)，默认 10000，0=不自动关闭
}

export interface PingResult {
  host: string        // 目标主机（原始输入）
  addr: string        // 回包 IP 地址
  alive: true
  time: number        // RTT(ms)
  ttl: number
  bytes: number
  seq: number
}

export interface PingStats {
  host: string
  alive: boolean
  min: number
  max: number
  avg: number
  packetLoss: number  // 0.0 - 1.0
  replies: PingResult[]
  errors: Error[]
}

export interface PingFailResult {
  host: string
  alive: false
  error: string
}

export class PingTimeoutError extends Error {
  name: 'PingTimeoutError'
  target: string
}

export class DestinationUnreachableError extends Error {
  name: 'DestinationUnreachableError'
  target: string
  icmpType: number
  icmpCode: number
}

export class Session {
  constructor(options?: SessionOptions)
  ping(target: string, opts?: { count?: number }): Promise<PingResult | PingStats>
  pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, rcvd: Date) => void): void
  pingBatch(targets: string[], opts?: { count?: number }): Promise<Map<string, PingResult | PingStats | PingFailResult>>
  close(): void
  on(event: 'close', listener: () => void): this
}

export class DefaultSession {
  setConfig(config: DefaultSessionConfig): void
  ping(target: string, opts?: { count?: number }): Promise<PingResult | PingStats>
  pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, rcvd: Date) => void): void
  pingBatch(targets: string[], opts?: { count?: number }): Promise<Map<string, PingResult | PingStats | PingFailResult>>
  close(): void
}

export const session: DefaultSession
export function createSession(options?: SessionOptions): Session
```

---

## 架构图

```
┌─────────────────── JS 层 (index.js) ───────────────────┐
│                                                        │
│  DefaultSession（默认导出 session）                      │
│  ├── 懒加载：首次 ping 时创建内部 Session               │
│  ├── keepAlive：空闲 10s 自动关闭                       │
│  └── setConfig / ping / pingHost / pingBatch / close   │
│                                                        │
│  Session extends EventEmitter                          │
│  ├── pingHost(target, cb)     → callback 风格          │
│  ├── ping(target, opts)       → Promise 风格           │
│  └── pingBatch(targets, opts) → 并发多目标             │
│                                                        │
│  createSession(opts) → Session                         │
│                                                        │
└───────────────────────┬────────────────────────────────┘
                        │ require('./binding')
┌───────────────────────▼────────────────────────────────┐
│           Rust Native Layer (napi-rs)                   │
│                                                        │
│  NativePingSession::new(options, onReply, onTimeout, onError)
│  ├── sendPing(target: string) → seq: number            │
│  ├── pendingCount() → number                           │
│  └── close()                                           │
│                                                        │
│  内部封装 ping-core::PingSession                        │
│  回调通过 ThreadsafeFunction 桥接到 JS                  │
└───────────────────────┬────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────┐
│           ping-core（纯 Rust，无 napi 依赖）            │
│                                                        │
│  struct PingSession {                                  │
│      socket: Arc<IcmpSocket>,     // 1 个 ICMP socket  │
│      identifier: u16,             // ICMP id（PID 低16位）│
│      next_seq: AtomicU16,         // seq 分配器        │
│      pending: Arc<Mutex<HashMap<  // 回包匹配表        │
│          u16,                     //   key = seq       │
│          PendingRequest           //   val = 请求信息  │
│      >>>,                                              │
│      running: Arc<AtomicBool>,    // 运行标志          │
│      recv_handle: JoinHandle,     // 1 个 recv 线程    │
│  }                                                     │
│                                                        │
│  EventCallback = Box<dyn Fn(PingEvent) + Send + Sync>  │
│  PingEvent: Reply / Timeout / IcmpError                │
└────────────────────────────────────────────────────────┘
```

---

## 线程模型

```
Node.js 主线程                         Rust recv 线程（唯一的额外线程）
│                                      │
├─ session.ping('8.8.8.8')             │
│  → JS: _sendOne('8.8.8.8')          │
│  → native.sendPing('8.8.8.8')       │
│    → Rust: 解析 IP / DNS 解析        │
│    → 构造 ICMP 包 (seq=1)            │
│    → sendto(socket)                  │
│    → pending.insert(seq=1, info)     │
│    → 返回 seq=1 给 JS               │
│                                      │
├─ session.ping('1.1.1.1')             ├─ recvfrom(socket)
│  → native.sendPing('1.1.1.1')       │  → 收到回包 (id=xxx, seq=1)
│    → 构造 ICMP 包 (seq=2)            │  → pending.remove(seq=1)
│    → sendto(socket)                  │  → callback(PingEvent::Reply)
│    → pending.insert(seq=2, info)     │    → tsfn 通知 JS 主线程
│                                      │
│  ← onReply 触发                      ├─ recvfrom(socket)
│    → JS pending.delete(seq=1)        │  → 收到回包 (id=xxx, seq=2)
│    → resolve Promise #1              │  → tsfn 通知 JS 主线程
│                                      │
│  ← onReply 触发                      │
│    → resolve Promise #2              │
```

**为什么用 1 个 recv 线程：**
- napi-rs 没有 libuv poll 的直接 API
- ThreadsafeFunction 是 napi-rs 从非主线程回调 JS 的标准模式
- 只有 1 个线程，开销极小（~8KB 栈）
- 不阻塞 Node.js 主线程
- 回调通过 NativePingSession constructor 一次性注册（onReply、onTimeout、onError）

---

## 超时与重试

```
send_ping(seq=1) ──────────────────────── timeout!
    │                                       │
    │  等待 opts.timeout ms                  │ retry_count < opts.retries?
    │                                       │
    │                                    ┌──▼──┐
    │                                    │ YES │→ 重新 sendto(同一个 seq)
    │                                    └──┬──┘   重置计时器
    │                                       │
    │                                    ┌──▼──┐
    │                                    │ NO  │→ 报 RequestTimedOutError
    │                                    └─────┘   从 pending 移除
    │
    ▼ 收到回包
    resolve(reply)
```

实现方式：
- socket 设置 `SO_RCVTIMEO = 100ms`（短周期轮询）
- recv 线程每次 recvfrom 超时后扫描 pending 表
- 检查每个请求是否超过 `timeout`，超过则重试或报错

---

## 项目结构

```
rust-ping/
├── Cargo.toml                  # Workspace
├── package.json                # npm 包 + napi-rs 构建脚本
├── index.js                    # JS 封装层：Session + DefaultSession
├── index.mjs                   # ESM 入口（re-export CJS）
├── index.d.ts                  # TypeScript 类型定义
├── binding.js                  # napi-rs 自动生成的 native binding 加载器
├── crates/
│   ├── ping-core/              # 纯 Rust（无 napi 依赖，可独立测试）
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs          # 模块入口 + re-exports
│   │       ├── icmp.rs         # ICMP 包构造/解析/校验和
│   │       ├── socket.rs       # 跨平台 IcmpSocket 抽象
│   │       ├── session.rs      # PingSession 多路复用引擎
│   │       ├── error.rs        # 统一错误类型 PingError
│   │       ├── utils.rs        # 工具函数（checksum、DNS 解析、时间转换）
│   │       └── platform/
│   │           ├── mod.rs
│   │           ├── windows.rs  # SOCK_RAW, Administrator
│   │           ├── linux.rs    # SOCK_DGRAM (ping_group_range)
│   │           └── macos.rs    # SOCK_DGRAM, 无需 root
│   └── ping-napi/              # napi-rs 绑定（薄层，只做类型转换 + tsfn 桥接）
│       ├── Cargo.toml
│       ├── build.rs
│       └── src/
│           └── lib.rs          # NativePingSession + JS 类型定义
├── __test__/
│   └── ping.test.js            # 测试
└── example/
    ├── 01-callback.js
    ├── 02-promise.js
    ├── 03-promise-stats.js
    ├── 04-batch.js
    ├── 05-concurrent-100.js
    ├── 06-timeout-retry.js
    ├── 07-memory-check.js
    └── 08-default-session.js
```

---

## 依赖

```toml
# Cargo.toml (workspace)
[workspace]
members = ["crates/ping-core", "crates/ping-napi"]
resolver = "2"

# crates/ping-core/Cargo.toml
[dependencies]
socket2 = { version = "0.5", features = ["all"] }
thiserror = "2"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Networking_WinSock"] }

[target.'cfg(unix)'.dependencies]
libc = "0.2"

# crates/ping-napi/Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
ping-core = { path = "../ping-core" }
napi = { version = "2", features = ["napi9"] }
napi-derive = "2"

[build-dependencies]
napi-build = "2"
```

```json
// package.json
{
  "name": "rust-ping",
  "version": "0.1.0",
  "main": "index.js",
  "module": "index.mjs",
  "types": "index.d.ts",
  "exports": {
    ".": {
      "import": "./index.mjs",
      "require": "./index.js",
      "types": "./index.d.ts"
    }
  },
  "napi": {
    "name": "ping",
    "triples": { "defaults": true }
  },
  "scripts": {
    "build": "napi build --platform --release --js binding.js --cargo-cwd crates/ping-napi",
    "build:debug": "napi build --platform --js binding.js --cargo-cwd crates/ping-napi",
    "test": "node __test__/ping.test.js"
  },
  "devDependencies": {
    "@napi-rs/cli": "^2.18.0"
  },
  "optionalDependencies": {
    "rust-ping-win32-x64-msvc": "0.1.0",
    "rust-ping-darwin-x64": "0.1.0",
    "rust-ping-darwin-arm64": "0.1.0",
    "rust-ping-linux-x64-gnu": "0.1.0",
    "rust-ping-linux-x64-musl": "0.1.0",
    "rust-ping-linux-arm64-gnu": "0.1.0"
  }
}
```

---

## 平台处理

| 平台 | Socket 类型 | 权限 | 回包解析 |
|------|------------|------|---------|
| Windows | `SOCK_RAW + IPPROTO_ICMP` | Administrator | 跳过 IP 头（20字节）再解析 ICMP |
| Linux | `SOCK_DGRAM + IPPROTO_ICMP` | 无需 root* | 直接解析 ICMP（无 IP 头） |
| macOS | `SOCK_DGRAM + IPPROTO_ICMP` | 无需 root | 直接解析 ICMP（无 IP 头） |

> *Linux 需要配置 `sysctl net.ipv4.ping_group_range="0 2147483647"` 或 `setcap cap_net_raw+ep`

---

## 实施顺序

1. **项目骨架** — Cargo workspace + package.json + napi-rs 配置
2. **ICMP 模块** — `EchoRequest::new()` / `parse_echo_reply()` / `internet_checksum()`
3. **跨平台 socket** — `IcmpSocket::new()` + platform 特化（windows/linux/macos）
4. **PingSession (Rust)** — 单 socket + recv 线程 + pending 表 + `send_ping()` + EventCallback
5. **napi 绑定层** — NativePingSession + ThreadsafeFunction 桥接
6. **JS 封装层** — Session 类 + DefaultSession + callback / Promise / batch 三种调用方式
7. **测试 & 示例验证**

---

## 验证方式

```bash
npm run build                           # 编译 release
npm run build:debug                     # 编译 debug
npm test                                # 运行测试
node example/02-promise.js              # 单次 Promise ping
node example/05-concurrent-100.js       # 并发 100 目标
node example/07-memory-check.js         # 内存泄露检测
node example/08-default-session.js      # DefaultSession 用法
```

