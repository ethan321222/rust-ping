//! ping-core: 跨平台 ICMP ping 核心库
//!
//! 模块结构：
//! - `icmp`     — ICMP 包构造、解析、校验和
//! - `socket`   — 跨平台 raw socket 抽象
//! - `session`  — PingSession 多路复用引擎
//! - `utils`    — 通用工具函数
//! - `error`    — 统一错误类型

pub mod error;
pub mod icmp;
pub mod platform;
pub mod session;
pub mod socket;
pub mod utils;

pub use error::{PingError, PingResult};
pub use session::{PingSession, PingReply, SessionOptions};
