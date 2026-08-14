//! 跨平台 ICMP socket 抽象
//!
//! 统一不同平台的 socket 创建差异，提供统一的 `IcmpSocket` 接口。

use socket2::Socket;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use crate::error::{PingError, PingResult};
use crate::platform;

/// 封装跨平台 ICMP raw socket
///
/// 屏蔽平台差异：
/// - Windows: SOCK_RAW，回包含 IP 头
/// - Linux: SOCK_DGRAM 优先（无 root），回包不含 IP 头
/// - macOS: SOCK_DGRAM，回包不含 IP 头
pub struct IcmpSocket {
    inner: Socket,
    /// 收到的回包是否包含 IP 头
    /// Windows SOCK_RAW = true, Linux/macOS SOCK_DGRAM = false
    pub has_ip_header: bool,
}

impl IcmpSocket {
    /// 创建 ICMP socket（自动选择平台最佳方式）
    pub fn new() -> PingResult<Self> {
        Self::create_platform_socket()
            .map_err(|e| PingError::SocketCreate(e.to_string()))
    }

    /// 平台特定的 socket 创建
    #[cfg(target_os = "windows")]
    fn create_platform_socket() -> io::Result<Self> {
        let socket = platform::windows::create_icmp_socket()?;
        Ok(Self {
            inner: socket,
            has_ip_header: true,
        })
    }

    #[cfg(target_os = "linux")]
    fn create_platform_socket() -> io::Result<Self> {
        let socket = platform::linux::create_icmp_socket()?;
        Ok(Self {
            inner: socket,
            has_ip_header: true,
        })
    }

    #[cfg(target_os = "macos")]
    fn create_platform_socket() -> io::Result<Self> {
        let socket = platform::macos::create_icmp_socket()?;
        Ok(Self {
            inner: socket,
            has_ip_header: true,
        })
    }

    /// 设置 socket 接收超时
    ///
    /// recv 线程用此控制轮询频率（通常 100ms）。
    pub fn set_recv_timeout(&self, timeout: Duration) -> PingResult<()> {
        self.inner
            .set_read_timeout(Some(timeout))
            .map_err(|e| PingError::Io(e))
    }

    /// 设置 TTL（IP 层 Time-To-Live）
    pub fn set_ttl(&self, ttl: u32) -> PingResult<()> {
        self.inner.set_ttl(ttl).map_err(|e| PingError::Io(e))
    }

    /// 发送 ICMP 包到目标地址
    pub fn send_to(&self, buf: &[u8], target: IpAddr) -> PingResult<usize> {
        let addr = match target {
            IpAddr::V4(v4) => SocketAddr::V4(SocketAddrV4::new(v4, 0)),
            IpAddr::V6(_) => {
                return Err(PingError::InvalidAddress("IPv6 not yet supported".into()))
            }
        };

        self.inner
            .send_to(buf, &addr.into())
            .map_err(|e| PingError::SendFailed(e.to_string()))
    }

    /// 接收数据（阻塞直到有数据或超时）
    ///
    /// 返回 (bytes_read, source_address)
    pub fn recv_from(&self, buf: &mut [u8]) -> io::Result<(usize, SocketAddr)> {
        let (n, addr) = self.inner.recv_from(unsafe {
            // SAFETY: buf 是有效的可写内存区域
            &mut *(buf as *mut [u8] as *mut [std::mem::MaybeUninit<u8>])
        })?;
        let sock_addr = addr
            .as_socket()
            .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0));
        Ok((n, sock_addr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_icmp_socket_creation() {
        // 注意：此测试需要管理员权限（Windows）或 ping_group_range 配置（Linux）
        // 在 CI 中可能会跳过
        match IcmpSocket::new() {
            Ok(socket) => {
                // 验证 has_ip_header 符合平台预期
                #[cfg(target_os = "windows")]
                assert!(socket.has_ip_header);
                #[cfg(target_os = "macos")]
                assert!(socket.has_ip_header);
            }
            Err(PingError::SocketCreate(msg)) => {
                // 权限不足时跳过（CI 环境）
                eprintln!("socket creation failed (expected in CI): {}", msg);
            }
            Err(e) => panic!("unexpected error: {:?}", e),
        }
    }
}
