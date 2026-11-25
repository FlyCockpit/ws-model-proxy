//! Relay protocol 4.0 frames in both directions.
//!
//! Serde mirror of `apps/server/src/relay/frames.ts`. Every fixture under
//! `tests/fixtures/relay-4.0/` must deserialize and serialize back to the same
//! JSON. Unknown server fields are ignored except in strict runtime definitions;
//! unknown frame types and invalid cross-field values are refused.

mod hello;
mod inventory;
mod node_frame;
mod node_info;
mod relay;
mod rules;
mod runtime;
mod server_frame;
mod update;

pub use hello::*;
pub use inventory::*;
pub use node_frame::*;
pub use node_info::*;
pub use relay::*;
pub use rules::*;
pub use runtime::*;
pub use server_frame::*;
pub use update::*;

pub const RELAY_PROTOCOL_VERSION: &str = "4.0";
pub const RELAY_SUBPROTOCOL: &str = "ws-model-proxy.relay.v4";

#[cfg(test)]
mod tests;
