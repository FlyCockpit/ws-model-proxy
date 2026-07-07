//! `wsmp config` commands.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::Config;
use crate::output;
use crate::slug::validate_slug;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Print the path to the config file.
    Path,
    /// Create a default JSON config file if one does not already exist.
    Init,
    /// Print the effective JSON config.
    Show,
    /// Set the self-hosted web app server URL.
    SetServer { url: String },
    /// Set this CLI connection's slug.
    SetSlug { slug: String },
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::Path => {
            let path = crate::paths::config_file()?;
            if args.json {
                output::json(&ConfigPath::new(&path))?;
            } else {
                output::line(path.display())?;
            }
        }
        Sub::Init => {
            let path = crate::paths::config_file()?;
            let created = Config::default()
                .save_new()
                .context("writing default config file")?;
            if args.json {
                output::json(&ConfigInit::new(&path, created))?;
            } else if created {
                output::line(format!("wrote config to `{}`", path.display()))?;
            } else {
                output::line(format!("config already exists at `{}`", path.display()))?;
            }
        }
        Sub::Show => {
            let cfg = Config::load_required()?;
            if args.json {
                output::json(&cfg)?;
            } else {
                output::text(serde_json::to_string_pretty(&cfg)?)?;
                output::line("")?;
            }
        }
        Sub::SetServer { url } => {
            let mut cfg = Config::load()?;
            url::Url::parse(url).with_context(|| format!("parsing server URL `{url}`"))?;
            cfg.server_url = Some(url.clone());
            cfg.save()?;
            if args.json {
                output::json(&SetValue {
                    key: "serverUrl",
                    value: url,
                })?;
            } else {
                output::line(format!("set server URL to `{url}`"))?;
            }
        }
        Sub::SetSlug { slug } => {
            validate_slug(slug)?;
            let mut cfg = Config::load()?;
            cfg.cli_slug = Some(slug.clone());
            cfg.save()?;
            if args.json {
                output::json(&SetValue {
                    key: "cliSlug",
                    value: slug,
                })?;
            } else {
                output::line(format!("set CLI slug to `{slug}`"))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ConfigPath {
    path: String,
}

impl ConfigPath {
    fn new(path: &Path) -> Self {
        Self {
            path: path.display().to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ConfigInit {
    path: String,
    created: bool,
}

impl ConfigInit {
    fn new(path: &Path, created: bool) -> Self {
        Self {
            path: path.display().to_string(),
            created,
        }
    }
}

#[derive(Debug, Serialize)]
struct SetValue<'a> {
    key: &'static str,
    value: &'a str,
}
