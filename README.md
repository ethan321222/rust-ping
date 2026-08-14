English | [中文文档](./README.zh.md)

> *A new programming paradigm: human-guided, AI-augmented.*
>
> *This project was built through iterative collaboration with Claude, DeepSeek-V4 , and Xiaomi MiMo‑V2.5‑Pro — where humans define the vision, and machines amplify execution.*

# rust-ping

[![GitHub stars](https://img.shields.io/github/stars/ethan321222/rust-ping?style=social)](https://github.com/ethan321222/rust-ping)
[![npm version](https://img.shields.io/npm/v/rust-ping)](https://www.npmjs.com/package/rust-ping)
[![npm downloads](https://img.shields.io/npm/dm/rust-ping)](https://www.npmjs.com/package/rust-ping)

High-performance ICMP ping for Node.js / Bun, powered by Rust.

All concurrent pings share a single ICMP socket — 100 pings at once use one socket, no child processes spawned.

## Highlights

- 🚀 **Fast** — Native Rust, single socket + single recv thread, zero process overhead, idle auto-cleanup
- 🔀 **Truly concurrent** — 100 parallel pings finish in ~70ms (vs. ~30s with process-per-ping approaches)
- 📦 **Flexible API** — Callback / Promise / Batch — pick what fits
- 🎯 **Zero build step** — Prebuilt binaries for all platforms, no node-gyp or compiler required
- 🔌 **Node-API (N-API)** — Stable ABI across Node.js versions; works in Electron / NW.js without recompilation
- 🌐 **DNS support** — Ping hostnames directly; resolution is handled internally
- ⏱️ **Timeout & retry** — Configurable timeout and retry count
- 💻 **Cross-platform** — Windows 7+, macOS 10.12+, Linux (glibc 2.17+ / musl)

## Install

```bash
npm install rust-ping
```

## Quick Start

**ESM:**

```js
import { session } from 'rust-ping';

const result = await session.ping('google.com');
console.log(result);
// { host: 'google.com', addr: '142.250.80.46', alive: true, time: 12.5, ttl: 117, bytes: 72, seq: 1 }
```

**CommonJS:**

```js
const { session } = require('rust-ping');

const result = await session.ping('google.com');
console.log(result);
```

Works out of the box — no manual session setup or teardown. The ICMP socket is created lazily on first ping and released automatically after 10 seconds of idle.

## Usage

### Option 1: Default session (recommended)

Import and go. The underlying ICMP socket is created on first use and released when idle.

```js
import { session } from 'rust-ping';

const result = await session.ping('8.8.8.8');
console.log(result.time); // RTT in ms

// Concurrent multi-target
const results = await session.pingBatch(['8.8.8.8', '1.1.1.1', '114.114.114.114']);
```

#### Configuration (`setConfig`)

Call `setConfig` to customize the default session. **Only works before the session is active** (before the first ping, or after close/keepAlive reclaim):

```js
import { session } from 'rust-ping';

session.setConfig({
  timeout: 5000,     // Per-ping timeout in ms (default: 2000)
  retries: 2,        // Retry count on timeout (default: 1)
  keepAlive: 30000,  // Idle lifetime in ms (default: 10000, 0 = never auto-close)
});

await session.ping('8.8.8.8'); // Uses the config above
```

**Calling `setConfig` while the session is active throws** — close it first:

```js
await session.ping('8.8.8.8');         // Session is now active

session.setConfig({ timeout: 1000 });  // ❌ Error: Cannot setConfig while session is active.

session.close();                       // Tear down manually
session.setConfig({ timeout: 1000 });  // ✅ Works now
await session.ping('8.8.8.8');         // Rebuilds with new config
```

#### Lifecycle

```
First ping() → creates socket + recv thread
            → subsequent pings reuse the same socket
            → auto-closes after keepAlive idle period (frees thread + socket)
Next ping()  → rebuilds automatically
```

You can also close manually:

```js
session.close(); // Immediate teardown. Can reconfigure and reuse afterward.
```

---

### Option 2: `createSession` (custom instance)

Use this when you need multiple sessions with different configurations, or full control over the lifecycle. **You must call `close()` to release resources.**

```js
import { createSession } from 'rust-ping';

const s = createSession({
  timeout: 5000,
  retries: 2,
  ttl: 64,
  packetSize: 32,
});

const result = await s.ping('8.8.8.8');
console.log(result);

// Always close when done — otherwise the recv thread and socket leak
s.close();
```

Use cases:
- Multiple sessions with different timeout / TTL settings
- Fine-grained control over when the socket is created / destroyed
- Long-running services where you want to avoid auto-rebuild overhead

```js
import { createSession } from 'rust-ping';

const fast = createSession({ timeout: 500, retries: 0 });
const slow = createSession({ timeout: 10000, retries: 3 });

await fast.ping('127.0.0.1');    // Quick probe
await slow.ping('10.0.0.1');     // Patient retry

fast.close();
slow.close();
```

---

## API

### `session.ping(target, opts?)`

Promise-based ping. Returns a single result or aggregated stats.

```js
// Single ping
const result = await session.ping('8.8.8.8');
// { host, addr, alive, time, ttl, bytes, seq }

// Multiple pings (returns stats)
const stats = await session.ping('8.8.8.8', { count: 5 });
// { host, alive, min, max, avg, packetLoss, replies, errors }
```

### `session.pingBatch(targets, opts?)`

Ping multiple targets concurrently. Returns a `Map<string, PingResult>`.

```js
const results = await session.pingBatch(['8.8.8.8', '1.1.1.1']);
for (const [target, result] of results) {
  console.log(`${target}: ${result.alive ? result.time + 'ms' : 'dead'}`);
}
```

### `session.pingHost(target, callback)`

Callback style (net-ping compatible).

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

Close the session, releasing the socket and recv thread. All pending requests are rejected.

---

## Error Handling

```js
import { session, PingTimeoutError, DestinationUnreachableError } from 'rust-ping';

try {
  await session.ping('10.255.255.1');
} catch (err) {
  if (err instanceof PingTimeoutError) {
    console.log('Timed out:', err.target);
  } else if (err instanceof DestinationUnreachableError) {
    console.log('Unreachable:', err.target, err.icmpType, err.icmpCode);
  }
}
```

| Error class | Meaning |
|-------------|---------|
| `PingTimeoutError` | Timed out (retries exhausted) |
| `DestinationUnreachableError` | ICMP destination unreachable |

## Performance

The single-socket multiplexing architecture means **total time for N concurrent pings ≈ the slowest one, not the sum**.

Benchmark (Windows 10, wired connection):

```
=== 10 concurrent targets ===

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
  Wall time: 63ms          ← not the cumulative 348ms; just ≈ the slowest ping

=== 100 concurrent pings (google.com) ===

  Success: 100/100
  RTT min/avg/max: 44.87 / 47.02 / 51.62ms
  Wall time: 73ms          ← 100 × 47ms = 4700ms sequentially? Nope, 73ms.
```

Comparison:

| Approach | 100 concurrent | Wall time | Resource usage |
|----------|---------------|-----------|----------------|
| node-ping (child processes) | Queued or 100 processes | ~30s | 100 processes, ~50 MB |
| **rust-ping (single socket)** | **True concurrency, 1 socket** | **~73ms** | **1 thread, ~hundreds of KB** |

## Platform Support

| Platform | Minimum version | Architectures | Permissions |
|----------|----------------|---------------|-------------|
| Windows | 7 / Server 2008 R2+ | x64 | Administrator |
| macOS | 10.12 Sierra+ | x64 (Intel), ARM64 (Apple Silicon) | None required |
| Linux (glibc) | glibc 2.17+ (CentOS 7+) | x64, ARM64 | `ping_group_range` or `sudo` |
| Linux (musl) | Alpine 3.12+ | x64 | `ping_group_range` or `sudo` |

**Linux permissions:**
```bash
# Option 1: Set ping group range (recommended, persistent)
sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"

# Option 2: Run with sudo
sudo node app.js
```

## TypeScript

Type definitions are included — no need to install `@types`:

```ts
import { session, createSession, PingTimeoutError } from 'rust-ping';

const result = await session.ping('8.8.8.8');
```

## License

MIT
