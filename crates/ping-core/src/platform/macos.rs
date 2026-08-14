//! macOS 平台 ICMP socket 创建
//!
//! macOS 使用 SOCK_DGRAM + IPPROTO_ICMP，无需 root 权限。
//! 内核自动处理 IP 头，回包不含 IP 头。

use socket2::{Domain, Protocol, Socket, Type};
use std::io;

/// 创建 macOS ICMP socket
///
/// 特点：
/// - 无需 root 权限
/// - 回包不含 IP 头（has_ip_header = false）
/// - 内核自动处理 ICMP id 过滤（只收到自己的 reply）
pub fn create_icmp_socket() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
    Ok(socket)
}
