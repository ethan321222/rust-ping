//! 通用工具函数
//!
//! 纯粹的、与业务无关的通用逻辑。

use std::net::{IpAddr, ToSocketAddrs};

/// RFC 1071 Internet Checksum（16 位反码校验和）
///
/// 用于 ICMP/IP/TCP/UDP 等协议的校验和计算。
/// 将数据视为 16 位大端整数序列求和，折叠进位，取反。
///
/// # Examples
/// ```
/// use ping_core::utils::internet_checksum;
/// let data = [0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01];
/// let cksum = internet_checksum(&data);
/// assert_ne!(cksum, 0);
/// ```
pub fn internet_checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    let mut i = 0;

    // 按 16 位整数逐对累加
    while i + 1 < data.len() {
        let word = u16::from_be_bytes([data[i], data[i + 1]]);
        sum += word as u32;
        i += 2;
    }

    // 奇数字节：高字节位置补 0
    if i < data.len() {
        sum += (data[i] as u32) << 8;
    }

    // 折叠进位（可能需要两次）
    while (sum >> 16) != 0 {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }

    !(sum as u16)
}

/// 将主机名或 IP 字符串解析为 IpAddr
///
/// 支持直接 IP（"8.8.8.8"）和域名（"google.com"）。
/// 域名解析为多个地址时取第一个。
pub fn resolve_host(host: &str) -> std::io::Result<IpAddr> {
    // 先尝试直接解析为 IP
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }

    // 作为域名解析（带 :0 端口满足 ToSocketAddrs 要求）
    let addr_str = format!("{}:0", host);
    let mut addrs = addr_str.to_socket_addrs()?;

    addrs
        .next()
        .map(|sa| sa.ip())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no address found"))
}

/// 获取当前时间戳（微秒精度）
///
/// 用于 RTT 计算。返回自某个固定起点以来的微秒数。
pub fn now_microseconds() -> u64 {
    use std::time::Instant;
    // 使用 lazy_static 模式的 thread_local 作为时间基准
    thread_local! {
        static EPOCH: Instant = Instant::now();
    }
    EPOCH.with(|epoch| epoch.elapsed().as_micros() as u64)
}

/// 微秒转毫秒（保留两位小数精度）
pub fn micros_to_millis(micros: u64) -> f64 {
    micros as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_internet_checksum_zeros() {
        // 全零数据的校验和应为 0xFFFF
        let data = [0u8; 8];
        assert_eq!(internet_checksum(&data), 0xFFFF);
    }

    #[test]
    fn test_internet_checksum_known_value() {
        // ICMP Echo Request header: type=8, code=0, cksum=0, id=1, seq=1
        let mut data = vec![0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01];
        let cksum = internet_checksum(&data);
        // 写入校验和后再验证应为 0
        data[2] = (cksum >> 8) as u8;
        data[3] = (cksum & 0xFF) as u8;
        assert_eq!(internet_checksum(&data), 0);
    }

    #[test]
    fn test_internet_checksum_odd_length() {
        let data = [0x01, 0x02, 0x03];
        let cksum = internet_checksum(&data);
        // 验证校验和非零
        let padded = vec![0x01, 0x02, 0x03, 0x00];
        let _ = internet_checksum(&padded);
        assert_ne!(cksum, 0);
    }

    #[test]
    fn test_resolve_host_ip() {
        let ip = resolve_host("127.0.0.1").unwrap();
        assert_eq!(ip, IpAddr::from([127, 0, 0, 1]));
    }

    #[test]
    fn test_resolve_host_invalid() {
        // 无效域名应返回错误
        let result = resolve_host("this.host.definitely.does.not.exist.invalid");
        assert!(result.is_err());
    }

    #[test]
    fn test_micros_to_millis() {
        assert_eq!(micros_to_millis(1500), 1.5);
        assert_eq!(micros_to_millis(0), 0.0);
        assert_eq!(micros_to_millis(1000), 1.0);
    }
}
