//! Stable error codes for the file tools (plan section 2.1).
//!
//! The wire layer (a later phase) maps `FileError` to `file.rejected` /
//! an in-band `isError` result. Codes are part of the public contract, so the
//! serialized spelling is pinned by a test.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PathDenied,
    SecretFile,
    NotFound,
    NotAFile,
    NotADir,
    BinaryFile,
    TooLarge,
    Conflict,
    MatchCount,
    NoMatch,
    RedactedSpan,
    Exists,
    HardLinked,
    OwnerMismatch,
    Setuid,
    SpecialFile,
    IoError,
    Timeout,
    InvalidInput,
    Unsupported,
    Cancelled,
    Limit,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PathDenied => "path_denied",
            Self::SecretFile => "secret_file",
            Self::NotFound => "not_found",
            Self::NotAFile => "not_a_file",
            Self::NotADir => "not_a_dir",
            Self::BinaryFile => "binary_file",
            Self::TooLarge => "too_large",
            Self::Conflict => "conflict",
            Self::MatchCount => "match_count",
            Self::NoMatch => "no_match",
            Self::RedactedSpan => "redacted_span",
            Self::Exists => "exists",
            Self::HardLinked => "hard_linked",
            Self::OwnerMismatch => "owner_mismatch",
            Self::Setuid => "setuid",
            Self::SpecialFile => "special_file",
            Self::IoError => "io_error",
            Self::Timeout => "timeout",
            Self::InvalidInput => "invalid_input",
            Self::Unsupported => "unsupported",
            Self::Cancelled => "cancelled",
            Self::Limit => "limit",
        }
    }
}

/// A file-tool failure: a stable code, a short message that never carries file
/// content, and an optional small structured detail.
#[derive(Debug, Clone, PartialEq)]
pub struct FileError {
    pub code: ErrorCode,
    pub message: String,
    pub detail: Option<Value>,
}

pub type FileResult<T> = Result<T, FileError>;

impl FileError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathDenied, message)
    }

    pub fn conflict(current_etag: &str) -> Self {
        Self::new(
            ErrorCode::Conflict,
            "the file changed since it was read; re-read it and retry",
        )
        .with_detail(json!({ "currentEtag": current_etag }))
    }

    /// `io_error` carries the errno name only (never a path or file content).
    pub fn errno(errno: nix::errno::Errno) -> Self {
        match errno {
            nix::errno::Errno::ENOENT => {
                Self::new(ErrorCode::NotFound, "no such file or directory")
            }
            nix::errno::Errno::ENOTDIR => {
                Self::new(ErrorCode::NotADir, "a path component is not a directory")
            }
            nix::errno::Errno::EEXIST => Self::new(ErrorCode::Exists, "already exists"),
            other => Self::new(ErrorCode::IoError, format!("{other:?}")),
        }
    }

    pub fn io(err: &std::io::Error) -> Self {
        match err.raw_os_error() {
            Some(raw) => Self::errno(nix::errno::Errno::from_raw(raw)),
            None => Self::new(ErrorCode::IoError, format!("{:?}", err.kind())),
        }
    }

    /// Mutations may have committed before completion or rollback failed.
    /// Both relay paths interpret `io_error` as an unknown mutation outcome;
    /// a definitive refusal (including `cancelled`) would invite an unsafe retry.
    pub(crate) fn mutation_uncertain() -> Self {
        Self::new(ErrorCode::IoError, "the mutation outcome is unknown")
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "the operation was cancelled")
    }
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for FileError {}

impl From<std::io::Error> for FileError {
    fn from(err: std::io::Error) -> Self {
        Self::io(&err)
    }
}

impl From<nix::errno::Errno> for FileError {
    fn from(errno: nix::errno::Errno) -> Self {
        Self::errno(errno)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_code_matches_as_str() {
        for code in [
            ErrorCode::PathDenied,
            ErrorCode::SecretFile,
            ErrorCode::NotFound,
            ErrorCode::NotAFile,
            ErrorCode::NotADir,
            ErrorCode::BinaryFile,
            ErrorCode::TooLarge,
            ErrorCode::Conflict,
            ErrorCode::MatchCount,
            ErrorCode::NoMatch,
            ErrorCode::RedactedSpan,
            ErrorCode::Exists,
            ErrorCode::HardLinked,
            ErrorCode::OwnerMismatch,
            ErrorCode::Setuid,
            ErrorCode::SpecialFile,
            ErrorCode::IoError,
            ErrorCode::Timeout,
            ErrorCode::InvalidInput,
            ErrorCode::Unsupported,
            ErrorCode::Cancelled,
            ErrorCode::Limit,
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), code.as_str());
        }
    }

    #[test]
    fn io_error_carries_errno_name_only() {
        let err = FileError::errno(nix::errno::Errno::EXDEV);
        assert_eq!(err.code, ErrorCode::IoError);
        assert_eq!(err.message, "EXDEV");
    }
}
