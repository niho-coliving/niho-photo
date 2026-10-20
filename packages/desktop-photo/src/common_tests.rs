//! 共通の道具のテスト（NIHO Desktop の `photo_editing_tests.rs` から C2 #18390 で移した）。

use super::*;

#[test]
fn log_text_has_photo_paths_and_home_scrubbed() {
  let photos = vec![
    PathBuf::from("/test-data/users/me/Pictures/2026/P1.RW2"),
    PathBuf::from("/test-data/volumes/SD/DCIM/100/P2.RW2"),
  ];
  let scrubbed = scrub_paths(
    "open /test-data/users/me/Pictures/2026/P1.RW2 then /test-data/volumes/SD/DCIM/100/other.RW2 using /test-data/users/me/Library/x",
    &photos,
    Some("/test-data/users/me"),
  );
  assert_eq!(scrubbed, "open P1.RW2 then …/other.RW2 using ~/Library/x");
}
