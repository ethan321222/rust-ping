//! napi-rs 绑定层 — 将 ping-core 暴露给 Node.js/Bun
//!
//! 设计原则：
//! - 尽量薄：只做类型转换和 ThreadsafeFunction 桥接
//! - 所有业务逻辑在 ping-core 中

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;
use std::net::IpAddr;
use std::sync::Arc;

use ping_core::session::{EventCallback, PingEvent, SessionOptions};
use ping_core::PingSession;

// ─── JS 层 Options 类型 ───────────────────────────────────────────────────────

#[napi(object)]
pub struct JsSessionOptions {
    /// 单次超时(ms)，默认 2000
    pub timeout: Option<u32>,
    /// 重试次数，默认 1
    pub retries: Option<u32>,
    /// TTL，默认 128
    pub ttl: Option<u32>,
    /// payload 大小(bytes)，默认 64
    pub packet_size: Option<u32>,
}

// ─── JS 层回调数据类型 ────────────────────────────────────────────────────────

#[napi(object)]
pub struct JsPingReply {
    pub addr: String,
    pub seq: u32,
    pub ttl: u32,
    /// RTT in milliseconds
    pub time: f64,
    pub bytes: u32,
}

#[napi(object)]
pub struct JsPingTimeout {
    pub seq: u32,
    pub target: String,
}

#[napi(object)]
pub struct JsPingError {
    pub seq: u32,
    pub target: String,
    pub icmp_type: u32,
    pub icmp_code: u32,
}

// ─── 回调事件的统一封装（传给 ThreadsafeFunction）─────────────────────────────

// ─── NativePingSession ────────────────────────────────────────────────────────

#[napi]
pub struct NativePingSession {
    session: Option<PingSession>,
}

#[napi]
impl NativePingSession {
    /// 创建 PingSession
    ///
    /// `on_event` 回调在收到回包/超时/错误时触发。
    /// JS 层根据事件类型分发到对应的 handler。
    #[napi(constructor)]
    pub fn new(
        options: Option<JsSessionOptions>,
        on_reply: ThreadsafeFunction<JsPingReply, ErrorStrategy::CalleeHandled>,
        on_timeout: ThreadsafeFunction<JsPingTimeout, ErrorStrategy::CalleeHandled>,
        on_error: ThreadsafeFunction<JsPingError, ErrorStrategy::CalleeHandled>,
    ) -> Result<Self> {
        let opts = convert_options(options);

        let on_reply = Arc::new(on_reply);
        let on_timeout = Arc::new(on_timeout);
        let on_error = Arc::new(on_error);

        // 构建 EventCallback：将 PingEvent 转为 JS 回调
        let callback: EventCallback = Box::new(move |event| match event {
            PingEvent::Reply(reply) => {
                let js_reply = JsPingReply {
                    addr: reply.addr.to_string(),
                    seq: reply.seq as u32,
                    ttl: reply.ttl as u32,
                    time: ping_core::utils::micros_to_millis(reply.rtt_us),
                    bytes: reply.bytes as u32,
                };
                on_reply.call(Ok(js_reply), ThreadsafeFunctionCallMode::NonBlocking);
            }
            PingEvent::Timeout { seq, target } => {
                let js_timeout = JsPingTimeout {
                    seq: seq as u32,
                    target: target.to_string(),
                };
                on_timeout.call(Ok(js_timeout), ThreadsafeFunctionCallMode::NonBlocking);
            }
            PingEvent::IcmpError {
                seq,
                target,
                icmp_type,
                icmp_code,
            } => {
                let js_error = JsPingError {
                    seq: seq as u32,
                    target: target.to_string(),
                    icmp_type: icmp_type as u32,
                    icmp_code: icmp_code as u32,
                };
                on_error.call(Ok(js_error), ThreadsafeFunctionCallMode::NonBlocking);
            }
        });

        let session = PingSession::new(opts, callback)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(Self {
            session: Some(session),
        })
    }

    /// 发送 ping 请求，返回 sequence number
    #[napi]
    pub fn send_ping(&self, target: String) -> Result<u32> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| Error::from_reason("session is closed"))?;

        let ip: IpAddr = target
            .parse()
            .or_else(|_| {
                ping_core::utils::resolve_host(&target)
            })
            .map_err(|e| Error::from_reason(format!("invalid target: {}", e)))?;

        let seq = session
            .send_ping(ip)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(seq as u32)
    }

    /// 获取当前 pending 请求数量
    #[napi]
    pub fn pending_count(&self) -> u32 {
        self.session
            .as_ref()
            .map(|s| s.pending_count() as u32)
            .unwrap_or(0)
    }

    /// 关闭 session
    #[napi]
    pub fn close(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.close();
        }
    }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

fn convert_options(js_opts: Option<JsSessionOptions>) -> SessionOptions {
    let mut opts = SessionOptions::default();
    if let Some(o) = js_opts {
        if let Some(t) = o.timeout {
            opts.timeout = t as u64;
        }
        if let Some(r) = o.retries {
            opts.retries = r;
        }
        if let Some(t) = o.ttl {
            opts.ttl = t;
        }
        if let Some(p) = o.packet_size {
            opts.packet_size = p as usize;
        }
    }
    opts
}
