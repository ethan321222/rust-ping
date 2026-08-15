[English](./README.md) | 中文

> *一种新的编程范式：人类引导，AI 增强。*
>
> *本项目由 Claude、DeepSeek V4、Xiaomi MiMo‑V2.5‑Pro 协作迭代完成 —— 人类定义愿景，机器放大执行。*

# rust-ping

高性能 ICMP Ping 模块，基于 Rust 实现，适用于 Node.js / Bun。

单 socket 多路复用架构 —— 100 个并发 ping 共享 1 个 ICMP socket，无需 spawn 子进程。

## 特性

- 🚀 **高性能** — Rust 原生实现，单 socket + 单 recv 线程，零进程开销，空闲自动回收线程和 socket
- 🔀 **真并发** — 100 个并发 ping ≈ 几百毫秒（对比 node-ping 的 100 个子进程 ≈ 几十秒）
- 📦 **多种调用方式** — Callback / Promise / Batch，按需选择
- 🎯 **开箱即用** — 预编译二进制分发，无需 node-gyp，无需本地编译环境
- 🔌 **Node-API (N-API)** — ABI 稳定，不受 Node.js 版本升级影响，可直接用于 Electron / NW.js 等运行时，无需针对不同版本重新编译
- 🌐 **支持域名** — 自动 DNS 解析，直接 ping 域名
- ⏱️ **超时重试** — 可配置超时时间和重试次数
- 💻 **跨平台** — Windows 7+、macOS 10.12+、Linux (glibc 2.17+ / musl)

## 安装

```bash
npm install rust-ping
```

## 快速开始

**ESM：**

```js
import { session } from 'rust-ping';

const result = await session.ping('baidu.com');
console.log(result);
// { host: 'baidu.com', addr: '110.242.68.66', alive: true, time: 28.5, ttl: 52, bytes: 72, seq: 1 }
```

**CommonJS：**

```js
const { session } = require('rust-ping');

const result = await session.ping('baidu.com');
console.log(result);
```

开箱即用，无需手动创建/关闭 session。内部自动管理 ICMP socket 生命周期（空闲 10 秒自动释放）。

## 用法

### 方式一：默认 session（推荐）

导入即用，内部懒加载创建 ICMP socket，空闲后自动关闭，下次调用自动重建。适合大多数场景。

```js
import { session } from 'rust-ping';

// 直接 ping，首次调用时自动创建底层 session
const result = await session.ping('8.8.8.8');
console.log(result.time); // RTT (ms)

// 并发多目标
const results = await session.pingBatch(['8.8.8.8', '1.1.1.1', '114.114.114.114']);
```

#### 配置（`setConfig`）

默认 session 使用 `setConfig` 修改参数。**仅在 session 未激活时可调用**（首次 ping 之前，或 close/keepAlive 回收之后）：

```js
import { session } from 'rust-ping';

// 首次 ping 前配置
session.setConfig({
  timeout: 5000,     // 单次超时(ms)，默认 2000
  retries: 2,        // 超时重试次数，默认 1
  keepAlive: 30000,  // 空闲存活时间(ms)，默认 10000，0 表示不自动关闭
});

await session.ping('8.8.8.8'); // 用上述参数创建 session
```

**session 激活后调用 `setConfig` 会抛错**，需要先 `close()`：

```js
await session.ping('8.8.8.8');         // session 已激活

session.setConfig({ timeout: 1000 });  // ❌ Error: Cannot setConfig while session is active.

session.close();                       // 手动关闭
session.setConfig({ timeout: 1000 });  // ✅ 可以了
await session.ping('8.8.8.8');         // 用新参数自动重建
```

#### 生命周期

```
首次 ping() → 自动创建 socket + recv 线程
           → 后续 ping 复用同一 socket
           → 空闲 keepAlive 时间后自动关闭（释放线程和 socket）
下次 ping() → 自动重建
```

也可以手动关闭：

```js
session.close(); // 立即关闭，释放资源。之后可 setConfig + 再次使用
```

---

### 方式二：`createSession`（自定义实例）

需要多个不同配置的 session，或需要完全控制生命周期时使用。**必须手动调用 `close()` 释放资源。**

```js
import { createSession } from 'rust-ping';

const session = createSession({
  timeout: 5000,
  retries: 2,
  ttl: 64,
  packetSize: 32,
});

const result = await session.ping('8.8.8.8');
console.log(result);

// 用完必须关闭！否则 recv 线程和 socket 不会释放
session.close();
```

适用场景：
- 需要同时存在多个 session（不同超时、不同 TTL）
- 需要精确控制 socket 何时创建/销毁
- 长期运行的服务中需要避免自动重建的开销

```js
// 多实例并存
import { createSession } from 'rust-ping';

const fast = createSession({ timeout: 500, retries: 0 });
const slow = createSession({ timeout: 10000, retries: 3 });

await fast.ping('127.0.0.1');    // 快速探测
await slow.ping('10.0.0.1');     // 慢速重试

fast.close();
slow.close();
```

---

## API 详细

### `session.ping(target, opts?)`

Promise 风格单次/多次 ping。

```js
// 单次
const result = await session.ping('8.8.8.8');
// { host, addr, alive, time, ttl, bytes, seq }

// 多次（返回统计）
const stats = await session.ping('8.8.8.8', { count: 5 });
// { host, alive, min, max, avg, packetLoss, replies, errors }
```

### `session.pingBatch(targets, opts?)`

并发 ping 多个目标，返回 `Map<string, PingResult>`。

```js
const results = await session.pingBatch(['8.8.8.8', '1.1.1.1']);
for (const [target, result] of results) {
  console.log(`${target}: ${result.alive ? result.time + 'ms' : 'dead'}`);
}
```

### `session.pingHost(target, callback)`

Callback 风格（兼容 net-ping）。

```js
session.pingHost('8.8.8.8', (error, target, sent, rcvd) => {
  if (error) {
    console.log(`${target}: ${error.message}`);
  } else {
    console.log(`${target}: alive, RTT=${rcvd - sent}ms`);
  }
});
```

### `session.close()`

关闭 session，释放 socket 和 recv 线程。关闭后所有 pending 请求会被 reject。

---

## 错误处理

```js
import { session, PingTimeoutError, DestinationUnreachableError } from 'rust-ping';

try {
  await session.ping('10.255.255.1');
} catch (err) {
  if (err instanceof PingTimeoutError) {
    console.log('超时:', err.target);
  } else if (err instanceof DestinationUnreachableError) {
    console.log('不可达:', err.target, err.icmpType, err.icmpCode);
  }
}
```

| 错误类 | 含义 |
|--------|------|
| `PingTimeoutError` | 超时（含重试耗尽） |
| `DestinationUnreachableError` | ICMP 目标不可达 |

## 并发性能

单 socket 多路复用的核心优势：**100 个并发 ping 的总耗时 ≈ 最慢的那一个，而非逐个累加。**

实测数据（Windows 10, 有线网络）：

```
=== 并发 10 个不同目标 ===

  8.8.8.8           47.64ms
  8.8.4.4           47.56ms
  baidu.com         44.70ms
  208.67.222.222    44.63ms
  9.9.9.9           44.59ms
  127.0.0.1          0.01ms
  223.5.5.5         12.59ms
  119.29.29.29      36.77ms
  google.com        51.52ms
  github.com         8.64ms
  总耗时: 63ms          ← 不是累加的 348ms，而是 ≈ 最慢的 51ms

=== 并发 100 个 ping (google.com) ===

  成功: 100/100
  RTT min/avg/max: 44.87 / 47.02 / 51.62ms
  总耗时: 73ms          ← 100 次 × 47ms = 4700ms？不，只要 73ms
```

架构对比：

| 方案 | 100 次并发 | 总耗时 | 资源占用 |
|------|-----------|--------|---------|
| node-ping（spawn 子进程） | 串行排队或 100 个进程 | ~30 秒 | 100 个进程 ~50MB |
| **rust-ping（单 socket）** | **真并发，共享 1 个 socket** | **~73ms** | **1 个线程 ~几百 KB** |

## 平台支持

| 平台 | 最低版本 | 架构 | 权限要求 |
|------|---------|------|---------|
| Windows | 7 / Server 2008 R2+ | x64 | 管理员权限 |
| macOS | 10.12 Sierra+ | x64 (Intel), ARM64 (Apple Silicon) | Root (`sudo`) |
| Linux (glibc) | glibc 2.17+ (CentOS 7+) | x64, ARM64 | Root 或 `CAP_NET_RAW` |
| Linux (musl) | Alpine 3.12+ | x64 | Root 或 `CAP_NET_RAW` |

**权限说明：** rust-ping 在所有平台使用原始 ICMP socket (`SOCK_RAW`) 以保证 identifier 匹配可靠，需要提升权限：
```bash
sudo node app.js
```

## TypeScript

自带类型定义，无需安装 `@types`：

```ts
import { session, createSession, PingTimeoutError } from 'rust-ping';

const result = await session.ping('8.8.8.8');
```

## License

MIT
