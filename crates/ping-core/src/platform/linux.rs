//! Linux 平台 ICMP socket 创建
//!
//! 优先尝试 SOCK_DGRAM（利用 ping_group_range，无需 root），
//! 失败则回退到 SOCK_RAW（需要 CAP_NET_RAW 或 root）。
//!
//! SOCK_DGRAM 模式下回包不含 IP 头。

use socket2::{Domain, Protocol, Socket, Type};
use std::io;

/// 创建 Linux ICMP socket
///
/// 策略：SOCK_DGRAM 优先 → SOCK_RAW 回退
///
/// 返回 (socket, has_ip_header):
/// - SOCK_DGRAM: has_ip_header = false
/// - SOCK_RAW: has_ip_header = true
pub fn create_icmp_socket() -> io::Result<(Socket, bool)> {
    // 优先尝试 SOCK_DGRAM（无需 root，利用 ping_group_range）
    match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4)) {
        Ok(socket) => Ok((socket, false)),
        Err(_) => {
            // 回退到 SOCK_RAW（需要 CAP_NET_RAW）
            let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
            Ok((socket, true))
        }
    }
}
