//! Windows 平台 ICMP socket 创建
//!
//! Windows 上使用 SOCK_RAW + IPPROTO_ICMP，需要管理员权限。
//! 回包包含 IP 头，需要 strip_ipv4_header 处理。

use socket2::{Domain, Protocol, Socket, Type};
use std::io;

/// 创建 Windows ICMP raw socket
///
/// 特点：
/// - 需要 Administrator 权限
/// - 回包包含完整 IP 头（has_ip_header = true）
/// - 使用 FIONBIO 设置非阻塞（由 socket2 的 set_nonblocking 处理）
pub fn create_icmp_socket() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
    Ok(socket)
}
