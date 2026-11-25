//! The arguments and results of rename, mkdir and delete, the same on every
//! platform (`mutate` on Unix, `mutate_windows`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    pub from: String,
    pub to: String,
    pub overwrite: Option<bool>,
    /// With `overwrite: true` (required): the etag of the DESTINATION being
    /// replaced. Otherwise, optionally, the etag of the source.
    pub expected_etag: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recovered: Vec<String>,
    /// Etag of the moved file (none for directories).
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirArgs {
    pub path: String,
    pub parents: Option<bool>,
    pub mode: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MkdirResult {
    pub created: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs {
    pub path: String,
    pub expected_etag: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeleteResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recovered: Vec<String>,
    pub deleted: bool,
    #[serde(rename = "type")]
    pub kind: &'static str,
}
