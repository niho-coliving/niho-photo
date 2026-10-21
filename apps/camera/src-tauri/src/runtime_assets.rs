//! 公式配布のSDK runtimeを、独立検証できるMach-O sectionからTauriへ直接返す。
//! private verifierは候補を起動せず、この同じtable/payloadの実hashをSDKへ照合する。

use serde::Deserialize;

const MAGIC: &[u8; 16] = b"NIHO-PHOTO-RT1\0\0";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
  path: String,
  offset: usize,
  bytes: usize,
}

fn decode(bytes: &[u8]) -> Result<(Vec<Record>, &[u8], String), &'static str> {
  if bytes.len() < 24 || bytes.get(..16) != Some(MAGIC.as_slice()) {
    return Err("invalid SDK runtime header");
  }
  let length = u64::from_le_bytes(bytes[16..24].try_into().map_err(|_| "invalid runtime length")?);
  if length == 0 || length > 65536 || length as usize > bytes.len() - 24 {
    return Err("invalid SDK runtime index size");
  }
  let end = 24 + length as usize;
  let records: Vec<Record> = serde_json::from_slice(&bytes[24..end]).map_err(|_| "invalid SDK runtime index")?;
  if records.is_empty() || records.len() > 64 {
    return Err("invalid SDK runtime asset count");
  }
  let prefix = format!("{}/", records[0].path.rsplit_once('/').ok_or("invalid runtime path")?.0);
  let engine = prefix
    .strip_prefix("/develop-engine/niho-")
    .and_then(|value| value.strip_suffix('/'))
    .ok_or("invalid runtime engine")?;
  if engine.is_empty() || engine.starts_with('0') || !engine.bytes().all(|c| c.is_ascii_digit()) {
    return Err("invalid runtime engine");
  }
  let mut offset = 0usize;
  let mut previous = "";
  for record in &records {
    let name = record.path.strip_prefix(&prefix).ok_or("mixed runtime engine")?;
    if !prefix.starts_with("/develop-engine/niho-")
      || name.is_empty()
      || name.contains('/')
      || name.contains('\\')
      || name == "."
      || name == ".."
      || record.path.as_str() <= previous
      || record.offset != offset
      || record.bytes == 0
    {
      return Err("invalid SDK runtime asset record");
    }
    offset = offset.checked_add(record.bytes).ok_or("runtime size overflow")?;
    previous = &record.path;
  }
  if offset != bytes.len() - end {
    return Err("SDK runtime payload size mismatch");
  }
  Ok((records, &bytes[end..], prefix))
}

#[cfg(feature = "official-updates")]
mod official {
  use super::{decode, Record};
  use std::{
    borrow::Cow,
    sync::{Arc, OnceLock},
  };
  use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Context, Runtime,
  };

  #[used]
  #[cfg_attr(target_os = "macos", link_section = "__DATA_CONST,__niho_runtime")]
  static SDK_RUNTIME: [u8; include_bytes!(env!("NIHO_PHOTO_RUNTIME_BUNDLE")).len()] =
    *include_bytes!(env!("NIHO_PHOTO_RUNTIME_BUNDLE"));

  struct RuntimeAssets<R: Runtime> {
    records: Vec<Record>,
    payload: &'static [u8],
    prefix: String,
    fallback: Arc<OnceLock<Box<dyn Assets<R>>>>,
  }

  impl<R: Runtime> RuntimeAssets<R> {
    fn fallback(&self) -> &dyn Assets<R> {
      self
        .fallback
        .get()
        .expect("SDK runtime fallback must be installed")
        .as_ref()
    }
  }

  impl<R: Runtime> Assets<R> for RuntimeAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
      self.fallback().setup(app);
    }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
      let key = key.as_ref();
      if key.starts_with(&self.prefix) {
        return self
          .records
          .iter()
          .find(|record| record.path == key)
          .map(|record| Cow::Borrowed(&self.payload[record.offset..record.offset + record.bytes]));
      }
      self.fallback().get(&AssetKey::from(key))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
      let fallback = self.fallback().iter().filter(|(key, _)| !key.starts_with(&self.prefix));
      let runtime = self.records.iter().map(|record| {
        (
          Cow::Borrowed(record.path.as_str()),
          Cow::Borrowed(&self.payload[record.offset..record.offset + record.bytes]),
        )
      });
      Box::new(fallback.chain(runtime))
    }
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
      self.fallback().csp_hashes(html_path)
    }
  }

  pub fn install<R: Runtime>(context: &mut Context<R>) {
    let (records, payload, prefix) = decode(&SDK_RUNTIME).expect("official SDK runtime bundle must be valid");
    let fallback = Arc::new(OnceLock::new());
    let previous = context.set_assets(Box::new(RuntimeAssets {
      records,
      payload,
      prefix,
      fallback: fallback.clone(),
    }));
    assert!(fallback.set(previous).is_ok(), "SDK runtime must be installed once");
  }
}

#[cfg(feature = "official-updates")]
pub use official::install;

#[cfg(test)]
mod tests {
  use super::*;
  fn fixture(index: serde_json::Value, payload: &[u8]) -> Vec<u8> {
    let index = serde_json::to_vec(&index).unwrap();
    [MAGIC.as_slice(), &(index.len() as u64).to_le_bytes(), &index, payload].concat()
  }
  #[test]
  fn table_returns_exact_runtime_bytes() {
    let bytes = fixture(
      serde_json::json!([{"path":"/develop-engine/niho-13/runtime.wasm","offset":0,"bytes":4}]),
      b"wasm",
    );
    let (records, payload, prefix) = decode(&bytes).unwrap();
    assert_eq!(prefix, "/develop-engine/niho-13/");
    assert_eq!(
      &payload[records[0].offset..records[0].offset + records[0].bytes],
      b"wasm"
    );
  }
  #[test]
  fn invalid_table_cannot_fall_back_to_another_runtime() {
    for index in [
      serde_json::json!([{"path":"/develop-engine/niho-13/a","offset":1,"bytes":4}]),
      serde_json::json!([{"path":"/develop-engine/niho-13/../a","offset":0,"bytes":4}]),
      serde_json::json!([{"path":"/develop-engine/niho-13/a","offset":0,"bytes":4},{"path":"/develop-engine/niho-13/a","offset":4,"bytes":4}]),
    ] {
      assert!(decode(&fixture(index, b"wasm")).is_err());
    }
    assert!(decode(b"no runtime table").is_err());
  }
}
