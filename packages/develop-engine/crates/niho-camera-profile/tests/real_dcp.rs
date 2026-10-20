use std::path::Path;

use niho_camera_profile::dcp::{load_dcp, load_dcp_bytes, sha256_hex, DcpSpec};

#[test]
fn exact_niho_dcp_bytes_keep_their_sha_and_roundtrip() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp");
    let bytes = std::fs::read(&path).unwrap();
    let measured: DcpSpec =
        serde_json::from_str(&std::fs::read_to_string(path.with_extension("spec.json")).unwrap())
            .unwrap();
    assert_eq!(
        measured.to_dcp_bytes().unwrap(),
        bytes,
        "DCP must exactly regenerate from the public measured spec"
    );
    let loaded = load_dcp_bytes(&bytes).unwrap();
    assert_eq!(
        loaded.sha256,
        "177c2f0454fdd9d7e7496f7c9123fd0f04b3b8fae8b5417287cc871f06758229"
    );
    assert_eq!(loaded.sha256, sha256_hex(&bytes));
    assert_eq!(load_dcp(&path).unwrap().spec, loaded.spec);
    assert_eq!(DcpSpec::from_dcp_bytes(&bytes).unwrap(), loaded.spec);

    let written = loaded.spec.to_dcp_bytes().unwrap();
    assert_eq!(DcpSpec::from_dcp_bytes(&written).unwrap(), loaded.spec);
    assert_eq!(written, bytes);
    assert!(loaded.spec.forward_matrix1.is_some());
    assert!(loaded.spec.hue_sat_map.is_none());
}
