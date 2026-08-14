//! PingSession — 单 socket 多路复用 ping 引擎
//!
//! 设计：
//! - 1 个 ICMP socket（共享）
//! - 1 个 recv 线程（持续监听回包）
//! - pending 表通过 (identifier, sequence) 匹配请求与回包
//! - 支持并发：100 个 ping 调用共享同一 socket

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::error::{PingError, PingResult};
use crate::icmp::{self, EchoRequest, ECHO_REPLY, DESTINATION_UNREACHABLE, TIME_EXCEEDED};
use crate::socket::IcmpSocket;

// ─── 配置 ─────────────────────────────────────────────────────────────────────

/// Session 配置选项
#[derive(Debug, Clone)]
pub struct SessionOptions {
    /// 单次请求超时（ms）
    pub timeout: u64,
    /// 超时重试次数
    pub retries: u32,
    /// IP TTL
    pub ttl: u32,
    /// ICMP payload 大小（bytes）
    pub packet_size: usize,
    /// recv 线程轮询间隔（ms），控制超时检测精度
    pub poll_interval: u64,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            timeout: 2000,
            retries: 1,
            ttl: 128,
            packet_size: 64,
            poll_interval: 100,
        }
    }
}

// ─── 回包数据 ─────────────────────────────────────────────────────────────────

/// 单次 ping 的回复结果
#[derive(Debug, Clone)]
pub struct PingReply {
    /// 目标地址
    pub addr: IpAddr,
    /// 序列号
    pub seq: u16,
    /// 回包 TTL
    pub ttl: u8,
    /// 往返时间（微秒）
    pub rtt_us: u64,
    /// 回包字节数
    pub bytes: usize,
}

// ─── Pending 请求 ─────────────────────────────────────────────────────────────

/// 一个待匹配的 ping 请求
struct PendingRequest {
    target: IpAddr,
    sent_at: Instant,
    timeout: Duration,
    retry_count: u32,
    max_retries: u32,
    /// 请求对应的 ICMP 包（重试时复用）
    packet: Vec<u8>,
}

// ─── 回调类型 ─────────────────────────────────────────────────────────────────

/// Session 向外部通知回包结果的回调
pub enum PingEvent {
    /// 收到正常回复
    Reply(PingReply),
    /// 请求超时（已达最大重试）
    Timeout { seq: u16, target: IpAddr },
    /// ICMP 错误（目标不可达等）
    IcmpError { seq: u16, target: IpAddr, icmp_type: u8, icmp_code: u8 },
}

/// 事件回调函数签名
pub type EventCallback = Box<dyn Fn(PingEvent) + Send + Sync + 'static>;

// ─── PingSession ──────────────────────────────────────────────────────────────

/// Ping 会话 — 持有单个 ICMP socket，支持并发多路复用
///
/// 使用方式：
/// 1. `PingSession::new(options, callback)` 创建（自动启动 recv 线程）
/// 2. `session.send_ping(target)` 发送请求（返回 seq）
/// 3. 回包/超时/错误通过 callback 通知
/// 4. `session.close()` 关闭
pub struct PingSession {
    /// ICMP socket（Arc 共享给 recv 线程）
    socket: Arc<IcmpSocket>,
    /// ICMP identifier（本 session 的标识）
    identifier: u16,
    /// 自增 sequence 分配器
    next_seq: AtomicU16,
    /// 等待回包的请求表
    pending: Arc<Mutex<HashMap<u16, PendingRequest>>>,
    /// session 配置
    options: SessionOptions,
    /// recv 线程运行标志
    running: Arc<AtomicBool>,
    /// recv 线程 handle
    recv_handle: Option<JoinHandle<()>>,
}

impl PingSession {
    /// 创建新的 PingSession 并启动 recv 线程
    ///
    /// `callback` 在 recv 线程中被调用，用于通知回包/超时/错误。
    /// 在 napi 层，这个 callback 会包装 ThreadsafeFunction。
    pub fn new(options: SessionOptions, callback: EventCallback) -> PingResult<Self> {
        let socket = Arc::new(IcmpSocket::new()?);

        // 设置 TTL
        socket.set_ttl(options.ttl)?;

        // 设置 recv 超时（控制 recv 线程轮询频率）
        socket.set_recv_timeout(Duration::from_millis(options.poll_interval))?;

        // identifier 用进程 PID 低 16 位（和 net-ping 一致）
        let identifier = (std::process::id() % 65535) as u16;

        let pending: Arc<Mutex<HashMap<u16, PendingRequest>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let running = Arc::new(AtomicBool::new(true));

        // 启动 recv 线程
        let recv_handle = Self::spawn_recv_thread(
            Arc::clone(&socket),
            Arc::clone(&pending),
            Arc::clone(&running),
            identifier,
            callback,
        );

        Ok(Self {
            socket,
            identifier,
            next_seq: AtomicU16::new(1),
            pending,
            options,
            running,
            recv_handle: Some(recv_handle),
        })
    }

    /// 发送一个 ICMP Echo Request
    ///
    /// 返回分配的 sequence number，用于追踪此请求。
    /// 非阻塞：sendto 立即返回。
    pub fn send_ping(&self, target: IpAddr) -> PingResult<u16> {
        if !self.running.load(Ordering::Relaxed) {
            return Err(PingError::SessionClosed);
        }

        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let request = EchoRequest::new(self.identifier, seq, self.options.packet_size);
        let packet = request.to_bytes();

        // 发送
        self.socket.send_to(&packet, target)?;

        // 注册到 pending 表
        let pending_req = PendingRequest {
            target,
            sent_at: Instant::now(),
            timeout: Duration::from_millis(self.options.timeout),
            retry_count: 0,
            max_retries: self.options.retries,
            packet: packet.clone(),
        };

        self.pending.lock().unwrap().insert(seq, pending_req);

        Ok(seq)
    }

    /// 关闭 session：停止 recv 线程，清理资源
    pub fn close(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.recv_handle.take() {
            let _ = handle.join();
        }
    }

    /// 当前 pending 请求数量
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// 启动 recv 线程
    fn spawn_recv_thread(
        socket: Arc<IcmpSocket>,
        pending: Arc<Mutex<HashMap<u16, PendingRequest>>>,
        running: Arc<AtomicBool>,
        identifier: u16,
        callback: EventCallback,
    ) -> JoinHandle<()> {
        thread::spawn(move || {
            let mut buf = [0u8; 65535];
            let callback = Arc::new(callback);

            while running.load(Ordering::Relaxed) {
                // 尝试接收（阻塞直到有数据或超时）
                match socket.recv_from(&mut buf) {
                    Ok((n, src_addr)) => {
                        Self::handle_recv_packet(
                            &buf[..n],
                            src_addr,
                            socket.has_ip_header,
                            identifier,
                            &pending,
                            &callback,
                        );
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        // 超时：正常，继续检查 pending 表
                    }
                    Err(_) => {
                        // 其他错误：继续循环（避免线程退出）
                    }
                }

                // 检查超时的请求
                Self::check_timeouts(&socket, &pending, &callback);
            }
        })
    }

    /// 处理收到的 ICMP 包
    fn handle_recv_packet(
        raw: &[u8],
        src_addr: SocketAddr,
        has_ip_header: bool,
        identifier: u16,
        pending: &Arc<Mutex<HashMap<u16, PendingRequest>>>,
        callback: &Arc<EventCallback>,
    ) {
        // 提取 ICMP 数据（可能需要跳过 IP 头）
        let (ttl, icmp_data) = if has_ip_header {
            match icmp::strip_ipv4_header(raw) {
                Some((ttl, data)) => (ttl, data),
                None => return,
            }
        } else {
            // SOCK_DGRAM 模式：无 IP 头，TTL 需从 socket option 获取（暂用 0）
            // TODO: 通过 IP_RECVTTL socket option 获取真实 TTL
            (0u8, raw)
        };

        // 解析 ICMP 包
        let reply = match icmp::parse_echo_reply(icmp_data, ttl) {
            Some(r) => r,
            None => return,
        };

        // 检查是否是我们的包（identifier 匹配）
        if reply.icmp_type == ECHO_REPLY && reply.identifier == identifier {
            // 从 pending 表移除并计算 RTT
            let mut map = pending.lock().unwrap();
            if let Some(req) = map.remove(&reply.sequence) {
                let rtt_us = req.sent_at.elapsed().as_micros() as u64;
                callback(PingEvent::Reply(PingReply {
                    addr: src_addr.ip(),
                    seq: reply.sequence,
                    ttl: reply.ttl,
                    rtt_us,
                    bytes: reply.payload_len + icmp::ICMP_HEADER_LEN,
                }));
            }
        } else if reply.icmp_type == DESTINATION_UNREACHABLE || reply.icmp_type == TIME_EXCEEDED {
            // 错误回包：内嵌了原始请求的 ICMP 头
            // 从 payload 中提取原始请求的 identifier 和 sequence
            if icmp_data.len() >= icmp::ICMP_HEADER_LEN + 28 {
                // 错误包格式: ICMP header(8) + original IP header(20) + original ICMP header(8)
                let orig_icmp = &icmp_data[icmp::ICMP_HEADER_LEN + 20..];
                if orig_icmp.len() >= 8 {
                    let orig_id = u16::from_be_bytes([orig_icmp[4], orig_icmp[5]]);
                    let orig_seq = u16::from_be_bytes([orig_icmp[6], orig_icmp[7]]);
                    if orig_id == identifier {
                        let mut map = pending.lock().unwrap();
                        if let Some(req) = map.remove(&orig_seq) {
                            callback(PingEvent::IcmpError {
                                seq: orig_seq,
                                target: req.target,
                                icmp_type: reply.icmp_type,
                                icmp_code: reply.icmp_code,
                            });
                        }
                    }
                }
            }
        }
    }

    /// 检查 pending 表中超时的请求，执行重试或报超时
    fn check_timeouts(
        socket: &Arc<IcmpSocket>,
        pending: &Arc<Mutex<HashMap<u16, PendingRequest>>>,
        callback: &Arc<EventCallback>,
    ) {
        let mut map = pending.lock().unwrap();
        let mut timed_out: Vec<u16> = Vec::new();

        for (&seq, req) in map.iter_mut() {
            if req.sent_at.elapsed() > req.timeout {
                if req.retry_count < req.max_retries {
                    // 重试：重新发送同一个包
                    req.retry_count += 1;
                    req.sent_at = Instant::now();
                    let _ = socket.send_to(&req.packet, req.target);
                } else {
                    // 超过最大重试次数：报超时
                    timed_out.push(seq);
                }
            }
        }

        // 移除超时的请求并通知
        for seq in timed_out {
            if let Some(req) = map.remove(&seq) {
                callback(PingEvent::Timeout {
                    seq,
                    target: req.target,
                });
            }
        }
    }
}

impl Drop for PingSession {
    fn drop(&mut self) {
        self.close();
    }
}
