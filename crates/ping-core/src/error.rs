//! 统一错误类型

use thiserror::Error;

/// ping-core 所有操作的错误类型
#[derive(Debug, Error)]
pub enum PingError {
    /// socket 创建失败（通常是权限不足）
    #[error("failed to create socket: {0}")]
    SocketCreate(String),

    /// 发送失败
    #[error("send failed: {0}")]
    SendFailed(String),

    /// 接收失败
    #[error("receive failed: {0}")]
    RecvFailed(String),

    /// 请求超时（已达到最大重试次数）
    #[error("request timed out for {target} (seq={seq})")]
    Timeout { target: String, seq: u16 },

    /// 目标不可达
    #[error("destination unreachable: {target} ({reason})")]
    DestinationUnreachable { target: String, reason: String },

    /// 无效地址
    #[error("invalid address: {0}")]
    InvalidAddress(String),

    /// Session 已关闭
    #[error("session is closed")]
    SessionClosed,

    /// IO 错误
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result 别名
pub type PingResult<T> = std::result::Result<T, PingError>;
