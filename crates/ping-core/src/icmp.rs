//! ICMP Echo Request/Reply 构造与解析
//!
//! 只处理 ICMP Echo（ping）相关的包类型：
//! - Type 8: Echo Request（发出去）
//! - Type 0: Echo Reply（收回来）

use crate::utils::internet_checksum;

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/// ICMP Echo Request type
pub const ECHO_REQUEST: u8 = 8;
/// ICMP Echo Reply type
pub const ECHO_REPLY: u8 = 0;
/// ICMP Destination Unreachable type
pub const DESTINATION_UNREACHABLE: u8 = 3;
/// ICMP Time Exceeded type
pub const TIME_EXCEEDED: u8 = 11;
/// ICMP header 固定长度（不含 payload）
pub const ICMP_HEADER_LEN: usize = 8;

// ─── 数据结构 ─────────────────────────────────────────────────────────────────

/// ICMP Echo Request 包
#[derive(Debug, Clone)]
pub struct EchoRequest {
    pub identifier: u16,
    pub sequence: u16,
    pub payload: Vec<u8>,
}

/// 解析后的 ICMP Echo Reply
#[derive(Debug, Clone)]
pub struct EchoReply {
    pub icmp_type: u8,
    pub icmp_code: u8,
    pub identifier: u16,
    pub sequence: u16,
    pub ttl: u8,
    pub payload_len: usize,
}

// ─── 构造 ─────────────────────────────────────────────────────────────────────

impl EchoRequest {
    /// 创建一个 Echo Request
    pub fn new(identifier: u16, sequence: u16, payload_size: usize) -> Self {
        // 填充 payload：循环 'a'-'z' 字节（和系统 ping 类似）
        let payload: Vec<u8> = (0..payload_size)
            .map(|i| b'a' + (i % 26) as u8)
            .collect();

        Self {
            identifier,
            sequence,
            payload,
        }
    }

    /// 序列化为字节数组（含校验和计算）
    ///
    /// 返回的 bytes 可直接通过 socket sendto 发出。
    pub fn to_bytes(&self) -> Vec<u8> {
        let total_len = ICMP_HEADER_LEN + self.payload.len();
        let mut buf = Vec::with_capacity(total_len);

        // Header: type(1) + code(1) + checksum(2) + identifier(2) + sequence(2)
        buf.push(ECHO_REQUEST);
        buf.push(0); // code
        buf.push(0); // checksum placeholder
        buf.push(0); // checksum placeholder
        buf.extend_from_slice(&self.identifier.to_be_bytes());
        buf.extend_from_slice(&self.sequence.to_be_bytes());

        // Payload
        buf.extend_from_slice(&self.payload);

        // 计算并写入校验和
        let checksum = internet_checksum(&buf);
        buf[2] = (checksum >> 8) as u8;
        buf[3] = (checksum & 0xFF) as u8;

        buf
    }
}

// ─── 解析 ─────────────────────────────────────────────────────────────────────

/// 解析 ICMP Echo Reply
///
/// `buf` 应为纯 ICMP 数据（不含 IP 头）。
/// `ttl` 由调用方从 IP 头或 socket option 提取后传入。
pub fn parse_echo_reply(buf: &[u8], ttl: u8) -> Option<EchoReply> {
    if buf.len() < ICMP_HEADER_LEN {
        return None;
    }

    let icmp_type = buf[0];
    let icmp_code = buf[1];
    let identifier = u16::from_be_bytes([buf[4], buf[5]]);
    let sequence = u16::from_be_bytes([buf[6], buf[7]]);
    let payload_len = buf.len() - ICMP_HEADER_LEN;

    Some(EchoReply {
        icmp_type,
        icmp_code,
        identifier,
        sequence,
        ttl,
        payload_len,
    })
}

/// 从包含 IP 头的原始数据中提取 ICMP 部分
///
/// IPv4 头长度由 IHL 字段决定（通常 20 字节，最大 60 字节）。
/// 返回 (ttl, icmp_data_slice)。
pub fn strip_ipv4_header(buf: &[u8]) -> Option<(u8, &[u8])> {
    if buf.len() < 20 {
        return None;
    }

    // IP header length = (first byte & 0x0F) * 4
    let ihl = ((buf[0] & 0x0F) as usize) * 4;
    if buf.len() < ihl + ICMP_HEADER_LEN {
        return None;
    }

    let ttl = buf[8];
    Some((ttl, &buf[ihl..]))
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_echo_request_serialization() {
        let req = EchoRequest::new(0x1234, 0x0001, 8);
        let bytes = req.to_bytes();

        // 总长度 = 8 (header) + 8 (payload)
        assert_eq!(bytes.len(), 16);
        // Type = 8 (Echo Request)
        assert_eq!(bytes[0], ECHO_REQUEST);
        // Code = 0
        assert_eq!(bytes[1], 0);
        // Identifier
        assert_eq!(u16::from_be_bytes([bytes[4], bytes[5]]), 0x1234);
        // Sequence
        assert_eq!(u16::from_be_bytes([bytes[6], bytes[7]]), 0x0001);
    }

    #[test]
    fn test_echo_request_checksum_valid() {
        let req = EchoRequest::new(0x0001, 0x0001, 32);
        let bytes = req.to_bytes();

        // 对整个包（含校验和）再算一次，应得 0
        assert_eq!(internet_checksum(&bytes), 0);
    }

    #[test]
    fn test_parse_echo_reply() {
        // 构造一个 Echo Reply: type=0, code=0, cksum=xx, id=0x1234, seq=0x0005
        let mut buf = vec![
            ECHO_REPLY, 0x00, 0x00, 0x00, // type, code, checksum
            0x12, 0x34, // identifier
            0x00, 0x05, // sequence
            0x61, 0x62, 0x63, 0x64, // payload "abcd"
        ];
        // 写入正确校验和
        let cksum = internet_checksum(&buf);
        buf[2] = (cksum >> 8) as u8;
        buf[3] = (cksum & 0xFF) as u8;

        let reply = parse_echo_reply(&buf, 64).unwrap();
        assert_eq!(reply.icmp_type, ECHO_REPLY);
        assert_eq!(reply.identifier, 0x1234);
        assert_eq!(reply.sequence, 0x0005);
        assert_eq!(reply.ttl, 64);
        assert_eq!(reply.payload_len, 4);
    }

    #[test]
    fn test_parse_echo_reply_too_short() {
        let buf = [0x00; 4]; // 太短
        assert!(parse_echo_reply(&buf, 64).is_none());
    }

    #[test]
    fn test_strip_ipv4_header() {
        // 最小 IP 头 (20 bytes) + ICMP Echo Reply
        let mut raw = vec![0u8; 20 + 12];
        raw[0] = 0x45; // version=4, IHL=5 (20 bytes)
        raw[8] = 128; // TTL
        // ICMP 部分
        raw[20] = ECHO_REPLY;
        raw[24] = 0x12;
        raw[25] = 0x34;

        let (ttl, icmp) = strip_ipv4_header(&raw).unwrap();
        assert_eq!(ttl, 128);
        assert_eq!(icmp[0], ECHO_REPLY);
        assert_eq!(u16::from_be_bytes([icmp[4], icmp[5]]), 0x1234);
    }

    #[test]
    fn test_strip_ipv4_header_too_short() {
        let raw = [0u8; 10];
        assert!(strip_ipv4_header(&raw).is_none());
    }

    #[test]
    fn test_payload_pattern() {
        let req = EchoRequest::new(1, 1, 26);
        // payload 应为 a-z
        assert_eq!(&req.payload[..3], b"abc");
        assert_eq!(req.payload[25], b'z');
    }
}
