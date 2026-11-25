//! The relay wire format: protocol frames and their limits, metric-label and token rules, the
//! terminal channel's encryption and image records.

pub mod protocol;
pub mod telemetry_bounds;
pub mod terminal_crypto;
pub mod terminal_images;
pub mod tokens;
