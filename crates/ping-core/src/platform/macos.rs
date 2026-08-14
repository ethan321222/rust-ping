//! macOS 平台 ICMP socket 创建
//!
//! 使用 SOCK_RAW + IPPROTO_ICMP，需要 root 权限。
//! 与 node-net-ping (raw-socket) 行为一致：identifier 不被内核重写，回包含 IP 头。

use socket2::{Domain, Protocol, Socket, Type};
use std::io;

/// 创建 macOS ICMP socket (SOCK_RAW)
///
/// 特点：
/// - 需要 root 权限
/// - 回包含 IP 头（has_ip_header = true）
/// - identifier 不被内核重写，应用层可正确匹配
pub fn create_icmp_socket() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
    Ok(socket)
}
