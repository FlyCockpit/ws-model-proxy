//! `{{fabric_ip}}`, `{{fabric_iface}}` and `{{fabric_rdma_device}}`: derived
//! by the node from its own IP on the job's fabric, never sent by the server.
//!
//! The interface is the one that carries that address (`getifaddrs`); the
//! RDMA device is the InfiniBand/RoCE device bound to that interface
//! (`/sys/class/infiniband/<dev>/device/net/<iface>`, or
//! `/sys/class/net/<iface>/device/infiniband/<dev>`). Every derived name must
//! pass `is_fabric_device_name` before it reaches a command.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::Path;

use crate::protocol::frames::is_fabric_device_name;

/// The interface carrying `ip`, from `addresses` (interface → addresses).
pub fn interface_for(ip: &str, addresses: &BTreeMap<String, Vec<String>>) -> Option<String> {
    let wanted: IpAddr = ip.parse().ok()?;
    addresses
        .iter()
        .find(|(_, list)| {
            list.iter()
                .any(|address| address.parse::<IpAddr>().is_ok_and(|seen| seen == wanted))
        })
        .map(|(name, _)| name.clone())
        .filter(|name| is_fabric_device_name(name))
}

/// The RDMA device bound to `iface`, read under `sys` (normally `/sys`).
pub fn rdma_device_for(iface: &str, sys: &Path) -> Option<String> {
    if !is_fabric_device_name(iface) {
        return None;
    }
    if let Ok(entries) =
        std::fs::read_dir(sys.join("class/net").join(iface).join("device/infiniband"))
    {
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        if let Some(name) = names.into_iter().find(|name| is_fabric_device_name(name)) {
            return Some(name);
        }
    }
    let devices = std::fs::read_dir(sys.join("class/infiniband")).ok()?;
    let mut names: Vec<String> = devices
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    names.into_iter().find(|device| {
        is_fabric_device_name(device)
            && sys
                .join("class/infiniband")
                .join(device)
                .join("device/net")
                .join(iface)
                .exists()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_interface_is_the_one_carrying_the_address() {
        let mut addresses = BTreeMap::new();
        addresses.insert("lo".to_string(), vec!["127.0.0.1".to_string()]);
        addresses.insert(
            "enp1s0f0".to_string(),
            vec!["10.0.0.5".to_string(), "fe80::1".to_string()],
        );
        addresses.insert("bad;name".to_string(), vec!["10.0.0.9".to_string()]);
        assert_eq!(
            interface_for("10.0.0.5", &addresses).as_deref(),
            Some("enp1s0f0")
        );
        assert_eq!(interface_for("10.0.0.6", &addresses), None);
        // A name that is not plain never reaches a command.
        assert_eq!(interface_for("10.0.0.9", &addresses), None);
    }

    #[test]
    fn the_rdma_device_is_found_from_either_side() {
        let sys = tempfile::tempdir().expect("sys");
        std::fs::create_dir_all(
            sys.path()
                .join("class/net/enp1s0f0/device/infiniband/mlx5_0"),
        )
        .expect("net side");
        assert_eq!(
            rdma_device_for("enp1s0f0", sys.path()).as_deref(),
            Some("mlx5_0")
        );
        std::fs::create_dir_all(sys.path().join("class/infiniband/mlx5_1/device/net/ib0"))
            .expect("ib side");
        assert_eq!(
            rdma_device_for("ib0", sys.path()).as_deref(),
            Some("mlx5_1")
        );
        assert_eq!(rdma_device_for("eth9", sys.path()), None);
        assert_eq!(rdma_device_for("../x", sys.path()), None);
    }
}
