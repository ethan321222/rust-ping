# Changelog

## v1.0.1 — macOS ICMP Socket 修复

### 问题

macOS 上所有 ping 请求都超时，`npm test` 大面积失败（12/36 failed），但系统 `ping` 命令正常工作。

### 根因分析

之前 macOS 使用 `SOCK_DGRAM + IPPROTO_ICMP` 创建 ICMP socket，这种方式无需 root 权限，但存在一个关键行为差异：

**macOS 内核会重写 ICMP Echo Request 的 identifier 字段。**

具体来说：
1. 应用层构造 ICMP 包，设置 `identifier = process_id % 65535`
2. 通过 SOCK_DGRAM socket 发送时，macOS 内核将 identifier 替换为内核分配的值
3. 目标主机原样返回 Echo Reply（带着内核分配的 identifier）
4. 应用层收到回包后检查 `reply.identifier == our_identifier` → **永远不匹配**
5. 回包被丢弃 → 所有请求最终超时

### SOCK_DGRAM vs SOCK_RAW 对比

| 特性 | SOCK_DGRAM | SOCK_RAW |
|------|-----------|----------|
| 权限要求 | 无需 root | 需要 root/CAP_NET_RAW |
| IP 头处理 | 内核自动处理，回包不含 IP 头 | 回包含完整 IP 头 |
| ICMP identifier | **各平台行为不一致，不可依赖** | 所有平台保留原值 |
| 回包过滤 | 内核按 socket 自动过滤 | 收到所有 ICMP 包，需应用层过滤 |
| TTL 获取 | 需额外 socket option (IP_RECVTTL) | 直接从 IP 头解析 |

### 修复方案

参考 [node-net-ping](https://github.com/stephenwvick/node-net-ping) 的做法（底层使用 `raw-socket` 模块，所有平台统一 SOCK_RAW），将 macOS 改为使用 `SOCK_RAW`：

```rust
// 修复前 (SOCK_DGRAM)
pub fn create_icmp_socket() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
    Ok(socket)
}

// 修复后 (SOCK_RAW)
pub fn create_icmp_socket() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
    Ok(socket)
}
```

三个平台现在行为统一：

| 平台 | Socket 类型 | has_ip_header | 权限要求 |
|------|------------|---------------|---------|
| Windows | SOCK_RAW | true | 管理员 |
| Linux | SOCK_RAW | true | root 或 CAP_NET_RAW |
| macOS | SOCK_RAW | true | root (sudo) |

所有平台统一使用 SOCK_RAW，行为一致，无平台特殊分支。

### 经验总结

1. **不要假设所有平台的 SOCK_DGRAM ICMP 行为一致** — macOS 和 Linux 对 identifier 字段的处理完全不同
2. **参考成熟项目的做法** — node-net-ping 选择 SOCK_RAW 是有原因的，简单统一比聪明的 fallback 更可靠
3. **诊断超时问题时，先确认包是否真的发出/收到** — 这类问题的表现是"超时"，但根因是收到了回包却没匹配上
