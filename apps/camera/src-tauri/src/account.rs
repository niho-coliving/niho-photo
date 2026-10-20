//! 公式NIHO app-connect。公開Firebase Web API keyの無いbuildはlocal-only。
//! 設定はbundled native codeで監査して与える。URLやtokenをIPCから受け取らない。
use niho_desktop_account::{Account, AccountSnapshot, ClientId, Config, FileSecretStore, Secret};
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

type SharedAccount = Arc<Account>;

pub fn install(app: &tauri::AppHandle) {
  let configured = option_env!("NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY")
    .filter(|key| !key.is_empty())
    .and_then(|key| Config::production(ClientId::Camera, key).ok())
    .and_then(|config| {
      app.path().app_data_dir().ok().and_then(|dir| {
        FileSecretStore::in_data_dir(&dir.join("public-account-v2"))
          .ok()
          .map(|store| Account::new(config, Arc::new(store)))
      })
    });
  let account = Arc::new(configured.unwrap_or_else(Account::disabled));
  app.manage(Arc::clone(&account));
  let callbacks = Arc::clone(&account);
  app.deep_link().on_open_url(move |event| {
    for url in event.urls() {
      let account = Arc::clone(&callbacks);
      let raw = Secret::new(url.as_str());
      tauri::async_runtime::spawn_blocking(move || {
        let _ = account.handle_callback(&raw);
      });
    }
  });
  // 起動時に届いたURLも、同じ永続pending/単回消費の検証を通す。
  let initial = app.deep_link().get_current().ok().flatten().unwrap_or_default();
  if account.snapshot().available {
    std::thread::spawn(move || {
      let _ = account.restore();
      for url in initial {
        let _ = account.handle_callback(&Secret::new(url.as_str()));
      }
      loop {
        let _ = account.maintain();
        std::thread::sleep(std::time::Duration::from_secs(1));
      }
    });
  }
}
#[tauri::command]
pub fn camera_account_state(account: State<'_, SharedAccount>) -> AccountSnapshot {
  account.snapshot()
}
#[tauri::command]
pub async fn camera_account_login(account: State<'_, SharedAccount>) -> Result<(), niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  tauri::async_runtime::spawn_blocking(move || account.login())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?
}
#[tauri::command]
pub fn camera_account_cancel(account: State<'_, SharedAccount>) -> Result<(), niho_desktop_account::AccountError> {
  account.cancel()
}
#[tauri::command]
pub async fn camera_account_logout(
  account: State<'_, SharedAccount>,
) -> Result<(), niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  tauri::async_runtime::spawn_blocking(move || account.logout())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?
}
#[tauri::command]
pub async fn camera_account_refresh(
  account: State<'_, SharedAccount>,
) -> Result<(), niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  tauri::async_runtime::spawn_blocking(move || account.refresh())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?
}
