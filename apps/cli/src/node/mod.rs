//! What this node is and may do, as stored on disk: config and the server origin it names, its
//! reported hostname, credential and enrollment, secrets, trust, approvals, identity keys, the
//! runtime store, shells.

pub mod approvals;
pub mod auth;
pub mod config;
pub mod engine_facts;
pub mod hostname;
pub mod origin;
pub mod runtime_store;
pub mod secrets;
pub mod shells;
pub mod state;
pub mod terminal_identity;
pub mod trust;
