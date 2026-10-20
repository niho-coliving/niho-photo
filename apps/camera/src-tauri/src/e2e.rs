//! 受入用の E2E の自動操作（cargo の feature `e2e` のときだけ入る。配布の build には入らない。`scripts/run-e2e.sh`）。
//!
//! コマンドを足さない（ACL を変えない）小さな plugin:
//! - main 窓の読み込みが終わったら、`NIHO_CAMERA_E2E_SCRIPT` のファイルの JS を 1 回だけ流す（`scripts/e2e/edit-and-export.js`）
//! - 画面が `https://niho-e2e.invalid/report?data=<JSON>` へ移ろうとしたら、移らずに（通信しない）`data` を
//!   `NIHO_CAMERA_E2E_REPORT` のファイルへ書き、アプリを終える。`/trace?…`（2 秒ごとの途中の記録）は移らずに `NIHO_CAMERA_E2E_TRACE`
//!   のファイルへ 1 行足す
//! - `/snapshot?name=<英数字と ->` は移らずに、main 窓の今の画面を PNG にして `NIHO_CAMERA_E2E_SNAPSHOT_DIR/<名前>.png` へ書き、
//!   画面の `window.__NIHO_CAMERA_E2E_SNAPSHOTS__` に結果を足す（画面は書けたのを確かめてから次へ進む）。見た目の確かめ用で、
//!   描画の走らない見せない窓では白くなるので `NIHO_CAMERA_E2E_WINDOW=visible` で撮る
//!
//! ダイアログは `dialog.rs` が環境変数の値を返す（`NIHO_CAMERA_E2E_PICK_FOLDER` など）。
//!
//! 窓が見えなくても（ほかの窓の後ろ・しまった・既定の見せない窓）最後まで流す。macOS は見えないアプリと画面の処理を 3 つの
//! 仕組みで止める（2026-10-15 に E2E と OS のログで確かめた）:
//! 1. アプリ（UI のプロセス）の App Nap: 見えない・前面でないアプリのタイマーと CPU を絞る → アプリの間ずっと
//!    `NSProcessInfo` の activity を持つ（公開 API。配布の build は現像・書き出しの間だけ持つ。`activity.rs`）
//! 2. 見えない画面の WebContent の停止（WKWebView の `inactiveSchedulingPolicy`。既定は suspend で、窓を見せずに始めると画面の JS が
//!    1 秒ほどで止まる）→ 窓の `backgroundThrottling` を Disabled（公開 API。macOS 14 から）
//! 3. 見えない画面の WebContent の App Nap（process suppression）と、見えない画面のタイマーの間引き（2 を切っても、操作の
//!    待ちの setTimeout が数分止まる）→ WKPreferences の private SPI で切る（E2E の build だけ）
//!
//! 既定では窓を見せず、Dock・メニューにも出さない（利用者の画面とキーボードを取らない）。`NIHO_CAMERA_E2E_WINDOW=visible` で
//! 窓を出す（前面に出したり常に手前にしたりはしない）。

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, Runtime};

/// 結果を受け取る先（`.invalid` は名前解決されない。移る前に止める）。
pub const REPORT_HOST: &str = "niho-e2e.invalid";
const MAIN_WINDOW_LABEL: &str = "main";

/// 報告の URL なら、その `data`（JSON の文字列）。
pub fn report_of(url: &tauri::Url) -> Option<String> {
  if url.host_str() != Some(REPORT_HOST) || url.path() != "/report" {
    return None;
  }
  Some(
    url
      .query_pairs()
      .find(|(key, _)| key == "data")
      .map(|(_, value)| value.into_owned())
      .unwrap_or_default(),
  )
}

/// 途中の記録の URL なら、その問い合わせ（`step=…&vis=…`）。
pub fn trace_of(url: &tauri::Url) -> Option<String> {
  (url.host_str() == Some(REPORT_HOST) && url.path() == "/trace").then(|| url.query().unwrap_or_default().to_string())
}

/// 画面の snapshot の URL なら、その名前（英数字と `-` だけ・64 文字まで。ほかは None）。
pub fn snapshot_of(url: &tauri::Url) -> Option<String> {
  if url.host_str() != Some(REPORT_HOST) || url.path() != "/snapshot" {
    return None;
  }
  let name = url.query_pairs().find(|(key, _)| key == "name")?.1.into_owned();
  let plain =
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
  plain.then_some(name)
}

/// snapshot を `NIHO_CAMERA_E2E_SNAPSHOT_DIR/<名前>.png` へ書き、画面へ書けたかを知らせる（`window.__NIHO_CAMERA_E2E_SNAPSHOTS__` に足す）。
fn finish_snapshot<R: Runtime>(webview: &tauri::Webview<R>, name: &str, png: Result<Vec<u8>, String>) {
  let written = png.and_then(|bytes| {
    let dir = std::env::var_os("NIHO_CAMERA_E2E_SNAPSHOT_DIR").ok_or("NIHO_CAMERA_E2E_SNAPSHOT_DIR がありません")?;
    let path = std::path::Path::new(&dir).join(format!("{name}.png"));
    std::fs::write(&path, &bytes).map_err(|err| format!("書けません: {err}"))?;
    Ok(bytes.len())
  });
  append_trace(&format!("snapshot {name} {written:?}"));
  let result = match written {
    Ok(bytes) => serde_json::json!({ "name": name, "ok": true, "bytes": bytes }),
    Err(error) => serde_json::json!({ "name": name, "ok": false, "error": error }),
  };
  let _ = webview.eval(format!("(window.__NIHO_CAMERA_E2E_SNAPSHOTS__ ??= []).push({result});"));
}

/// 窓を見せるか（既定は見せない）。
fn window_visible() -> bool {
  std::env::var("NIHO_CAMERA_E2E_WINDOW").is_ok_and(|value| matches!(value.as_str(), "visible" | "foreground"))
}

/// 窓の設定（見えない画面の WebContent を止めない・既定では窓を見せない）。
pub fn configure<R: Runtime>(context: &mut tauri::Context<R>) {
  let visible = window_visible();
  for window in &mut context.config_mut().app.windows {
    window.background_throttling = Some(BackgroundThrottlingPolicy::Disabled);
    // 実paintの連続測定だけ明示opt-in。通常のvisible/hidden受入と配布buildには適用しない。
    if std::env::var("NIHO_CAMERA_E2E_WINDOW").is_ok_and(|value| value == "foreground") {
      window.always_on_top = true;
      window.focus = true;
    }
    if !visible {
      window.visible = false;
      window.focus = false;
    }
  }
}

fn append_trace(line: &str) {
  let Some(path) = std::env::var_os("NIHO_CAMERA_E2E_TRACE") else {
    return;
  };
  let millis = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or_default();
  if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
    let _ = writeln!(file, "{millis} {line}");
  }
}

#[cfg(target_os = "macos")]
mod macos {
  use objc2::runtime::{AnyClass, AnyObject, Sel};
  use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
  use std::ffi::c_void;

  /// `NSBitmapImageFileTypePNG`
  const PNG_FILE_TYPE: usize = 4;

  /// main 窓の WKWebView の今の画面を PNG にする（公開 API `takeSnapshotWithConfiguration:completionHandler:`。描き終えるのを
  /// 待ってから撮る）。終わったら main thread で `done`。
  ///
  /// # Safety
  /// `webview` は main thread の WKWebView（`Webview::with_webview` の `inner()`）。
  pub unsafe fn snapshot_png(webview: *mut c_void, done: impl Fn(Result<Vec<u8>, String>) + 'static) {
    let Some(webview) = webview.cast::<AnyObject>().as_ref() else {
      done(Err("WKWebView がありません".into()));
      return;
    };
    let block = block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
      done(unsafe { png_of(image) }.ok_or_else(|| "snapshot を撮れませんでした".to_string()));
    });
    let configuration: *mut AnyObject = std::ptr::null_mut();
    let _: () = objc2::msg_send![webview, takeSnapshotWithConfiguration: configuration, completionHandler: &*block];
  }

  /// NSImage を PNG のバイト列にする（TIFF → NSBitmapImageRep → PNG）。
  unsafe fn png_of(image: *mut AnyObject) -> Option<Vec<u8>> {
    let image = image.as_ref()?;
    let tiff: *mut AnyObject = objc2::msg_send![image, TIFFRepresentation];
    let tiff = tiff.as_ref()?;
    let rep: *mut AnyObject = objc2::msg_send![AnyClass::get(c"NSBitmapImageRep")?, imageRepWithData: tiff];
    let rep = rep.as_ref()?;
    let properties: *mut AnyObject = objc2::msg_send![AnyClass::get(c"NSDictionary")?, dictionary];
    let png: *mut AnyObject = objc2::msg_send![rep, representationUsingType: PNG_FILE_TYPE, properties: properties];
    let png = png.as_ref()?;
    let length: usize = objc2::msg_send![png, length];
    let bytes: *const c_void = objc2::msg_send![png, bytes];
    (!bytes.is_null() && length > 0).then(|| std::slice::from_raw_parts(bytes.cast::<u8>(), length).to_vec())
  }

  fn responds(object: &AnyObject, selector: Sel) -> bool {
    unsafe { objc2::msg_send![object, respondsToSelector: selector] }
  }

  /// アプリの App Nap を止める（E2E の間ずっと。token は手放さない）。
  pub fn begin_activity() {
    let reason = NSString::from_str("NIHO photo E2E");
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
      NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
      &reason,
    );
    std::mem::forget(activity);
  }

  /// 見えない画面の WebContent の App Nap（process suppression）と、見えない画面のタイマーの間引きを切る（WKPreferences の
  /// private SPI。E2E だけ）。切れたかを返す。
  ///
  /// # Safety
  /// `webview` は main thread の WKWebView（`Webview::with_webview` の `inner()`）。
  pub unsafe fn keep_hidden_page_running(webview: *mut std::ffi::c_void) -> (bool, bool) {
    let Some(webview) = webview.cast::<AnyObject>().as_ref() else {
      return (false, false);
    };
    let configuration: *mut AnyObject = objc2::msg_send![webview, configuration];
    let Some(configuration) = configuration.as_ref() else {
      return (false, false);
    };
    let preferences: *mut AnyObject = objc2::msg_send![configuration, preferences];
    let Some(preferences) = preferences.as_ref() else {
      return (false, false);
    };
    let suppression = responds(
      preferences,
      objc2::sel!(_setPageVisibilityBasedProcessSuppressionEnabled:),
    );
    if suppression {
      let _: () = objc2::msg_send![preferences, _setPageVisibilityBasedProcessSuppressionEnabled: false];
    }
    let timers = responds(preferences, objc2::sel!(_setHiddenPageDOMTimerThrottlingEnabled:));
    if timers {
      let _: () = objc2::msg_send![preferences, _setHiddenPageDOMTimerThrottlingEnabled: false];
    }
    (suppression, timers)
  }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
  static INJECTED: AtomicBool = AtomicBool::new(false);
  Builder::new("niho-camera-e2e")
    .setup(|app, _api| {
      #[cfg(target_os = "macos")]
      {
        macos::begin_activity();
        // 窓を見せないときは Dock・メニューにも出さず、前面のアプリを替えない
        if !window_visible() {
          let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
      }
      #[cfg(not(target_os = "macos"))]
      let _ = app;
      append_trace(&format!(
        "start window={}",
        if window_visible() { "visible" } else { "hidden" }
      ));
      Ok(())
    })
    .on_webview_ready(|webview| {
      if webview.label() != MAIN_WINDOW_LABEL {
        return;
      }
      #[cfg(target_os = "macos")]
      let _ = webview.with_webview(|platform| {
        let (suppression, timers) = unsafe { macos::keep_hidden_page_running(platform.inner()) };
        append_trace(&format!(
          "hidden page: suppression off={suppression} timer throttling off={timers}"
        ));
      });
    })
    .on_page_load(|webview, payload| {
      if webview.label() != MAIN_WINDOW_LABEL || payload.event() != PageLoadEvent::Finished {
        return;
      }
      let Some(path) = std::env::var_os("NIHO_CAMERA_E2E_SCRIPT") else {
        return;
      };
      if INJECTED.swap(true, Ordering::SeqCst) {
        return;
      }
      match std::fs::read_to_string(&path) {
        Ok(script) => {
          let tracing = std::env::var_os("NIHO_CAMERA_E2E_TRACE").is_some();
          let snapshots = std::env::var_os("NIHO_CAMERA_E2E_SNAPSHOT_DIR").is_some();
          let script = format!(
            "window.__NIHO_CAMERA_E2E_TRACE__ = {tracing};\nwindow.__NIHO_CAMERA_E2E_SNAPSHOT__ = {snapshots};\n{script}"
          );
          if let Err(err) = webview.eval(&script) {
            eprintln!("[niho-camera-e2e] could not run the script: {err}");
          }
        }
        Err(err) => eprintln!("[niho-camera-e2e] could not read the script: {err}"),
      }
    })
    .on_navigation(|webview, url| {
      if let Some(trace) = trace_of(url) {
        append_trace(&trace);
        return false;
      }
      if let Some(name) = snapshot_of(url) {
        #[cfg(target_os = "macos")]
        {
          let target = webview.clone();
          let fallback = webview.clone();
          let fallback_name = name.clone();
          let scheduled = webview.with_webview(move |platform| unsafe {
            macos::snapshot_png(platform.inner(), move |png| finish_snapshot(&target, &name, png));
          });
          if scheduled.is_err() {
            finish_snapshot(&fallback, &fallback_name, Err("WKWebView に届きません".into()));
          }
        }
        #[cfg(not(target_os = "macos"))]
        finish_snapshot(webview, &name, Err("macOS だけ".into()));
        return false;
      }
      let Some(report) = report_of(url) else {
        return true;
      };
      append_trace("report");
      match std::env::var_os("NIHO_CAMERA_E2E_REPORT") {
        Some(path) => {
          if let Err(err) = std::fs::write(&path, report) {
            eprintln!("[niho-camera-e2e] could not write the report: {err}");
          }
        }
        None => eprintln!("[niho-camera-e2e] report: {report}"),
      }
      webview.app_handle().exit(0);
      false
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_report_and_trace_urls_are_read() {
    let url: tauri::Url = "https://niho-e2e.invalid/report?data=%7B%22ok%22%3Atrue%7D"
      .parse()
      .unwrap();
    assert_eq!(report_of(&url).as_deref(), Some("{\"ok\":true}"));
    let other: tauri::Url = "https://niho.life/report?data=x".parse().unwrap();
    assert_eq!(report_of(&other), None);
    let local: tauri::Url = "tauri://localhost/".parse().unwrap();
    assert_eq!(report_of(&local), None);
    let trace: tauri::Url = "https://niho-e2e.invalid/trace?step=a&vis=hidden".parse().unwrap();
    assert_eq!(trace_of(&trace).as_deref(), Some("step=a&vis=hidden"));
    assert_eq!(report_of(&trace), None);
    assert_eq!(trace_of(&url), None);
    assert_eq!(trace_of(&other), None);
    let snapshot: tauri::Url = "https://niho-e2e.invalid/snapshot?name=03-loupe".parse().unwrap();
    assert_eq!(snapshot_of(&snapshot).as_deref(), Some("03-loupe"));
    for bad in ["../x", "a/b", "", "a.png", "%2E%2E"] {
      let url: tauri::Url = format!("https://niho-e2e.invalid/snapshot?name={bad}").parse().unwrap();
      assert_eq!(snapshot_of(&url), None, "{bad}");
    }
    assert_eq!(snapshot_of(&trace), None);
  }
}
