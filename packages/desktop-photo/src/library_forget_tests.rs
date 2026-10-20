//! 覚えたフォルダの「一覧から外す」（NIHO camera。C3 #18391）のテスト。

use super::*;
use crate::test_support::library::*;
use std::fs;

fn folder_names(remembered: &Value) -> Vec<String> {
  remembered["folders"]
    .as_array()
    .unwrap()
    .iter()
    .map(|folder| folder["name"].as_str().unwrap().to_string())
    .collect()
}

#[test]
fn a_remembered_folder_is_taken_off_the_list_without_touching_its_photos() {
  let fixture = Fixture::new("forget-folder");
  let photo = fixture.file("SD/DCIM/DSC00001.JPG");
  let photo_before = fs::read(&photo).unwrap();
  fixture.file("Pictures/P1524180.RW2");
  let library = fixture.library();
  let dcim = library.add_folder(&fixture.root().join("SD/DCIM")).unwrap();
  library.add_folder(&fixture.root().join("Pictures")).unwrap();
  assert_eq!(folder_names(&library.remembered()), ["Pictures", "DCIM"]);

  library.forget_folder(dcim["folderId"].as_str().unwrap()).unwrap();
  assert_eq!(folder_names(&library.remembered()), ["Pictures"]);
  // 次の起動でも出ない。写真は消さない
  assert_eq!(folder_names(&fixture.library().remembered()), ["Pictures"]);
  assert_eq!(fs::read(&photo).unwrap(), photo_before);
  assert!(fixture.has_log("remembered_folder_forgotten"));
}

#[test]
fn only_a_remembered_root_folder_can_be_taken_off_the_list() {
  let fixture = Fixture::new("forget-folder-not-root");
  fixture.file("SD/DCIM/100MSDCF/DSC00001.JPG");
  let library = fixture.library();
  let dcim = library.add_folder(&fixture.root().join("SD/DCIM")).unwrap();
  let sub = dcim["children"][0]["folderId"].as_str().unwrap();
  // サブフォルダ・知らない ID は notFound（覚えたものは変えない）
  for folder_id in [sub, "folder-unknown"] {
    let err = library.forget_folder(folder_id).unwrap_err();
    assert_eq!(err.code, code::NOT_FOUND, "{folder_id}");
  }
  assert_eq!(folder_names(&library.remembered()), ["DCIM"]);
}
