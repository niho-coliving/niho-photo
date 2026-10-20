use crate::AccountError;
use std::{
  fmt,
  path::{Path, PathBuf},
};
use zeroize::Zeroizing;
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);
impl Secret {
  pub fn new(value: impl Into<String>) -> Self {
    Self(Zeroizing::new(value.into()))
  }
  pub fn expose(&self) -> &str {
    self.0.as_str()
  }
}
impl fmt::Debug for Secret {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("Secret([REDACTED])")
  }
}
impl<'de> serde::Deserialize<'de> for Secret {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    <String as serde::Deserialize>::deserialize(deserializer).map(Self::new)
  }
}
#[derive(Clone, Copy, Debug)]
pub enum SecretKind {
  Pending,
  RefreshToken,
}
impl SecretKind {
  pub(crate) fn name(self) -> &'static str {
    match self {
      Self::Pending => "pending",
      Self::RefreshToken => "refresh-token",
    }
  }
}
pub trait CredentialStore: Send + Sync {
  fn load(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError>;
  fn save(&self, kind: SecretKind, value: &Secret) -> Result<(), AccountError>;
  fn clear(&self, kind: SecretKind) -> Result<(), AccountError>;
}
/// Developer ID署名前の既定adapter。保存先はnativeが決め、IPCでは受け取らない。
pub struct FileSecretStore {
  dir: PathBuf,
}
impl FileSecretStore {
  pub fn in_data_dir(data_dir: &Path) -> Result<Self, AccountError> {
    if !data_dir.is_absolute()
      || data_dir
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir))
    {
      return Err(AccountError::Storage);
    }
    Ok(Self {
      dir: data_dir.join("account-secrets"),
    })
  }
}
impl fmt::Debug for FileSecretStore {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("FileSecretStore([REDACTED])")
  }
}
#[cfg(unix)]
mod files {
  use super::*;
  use std::ffi::CString;
  use std::fs::{self, File, OpenOptions};
  use std::io::{self, Read, Write};
  use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
  };
  const MAX_BYTES: u64 = 64 * 1024;
  fn uid() -> u32 {
    // SAFETY: getuidは引数も書込先も持たないOS問い合わせ。
    unsafe { libc::getuid() }
  }
  fn ancestors_safe(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
      match fs::symlink_metadata(ancestor) {
        Ok(meta) => {
          let root_sticky = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
          if !meta.is_dir()
            || meta.file_type().is_symlink()
            || (meta.uid() != uid() && meta.uid() != 0)
            || (meta.mode() & 0o022 != 0 && !root_sticky)
          {
            return Err(io::ErrorKind::PermissionDenied.into());
          }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
      }
    }
    Ok(())
  }
  fn directory(path: &Path) -> io::Result<File> {
    ancestors_safe(path)?;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    ancestors_safe(path)?;
    let file = OpenOptions::new()
      .read(true)
      .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
      .open(path)?;
    let meta = file.metadata()?;
    let current = fs::symlink_metadata(path)?;
    if meta.uid() != uid() || meta.mode() & 0o777 != 0o700 || meta.ino() != current.ino() || meta.dev() != current.dev()
    {
      return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
  }
  fn private_file(meta: &fs::Metadata, owner: u32) -> bool {
    meta.is_file()
      && meta.uid() == owner
      && meta.mode() & 0o7777 == 0o600
      && meta.nlink() == 1
      && meta.len() <= MAX_BYTES
  }
  fn open_at(dir: &File, name: &str, flags: i32) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: nameはNUL終端、dirは生存中のdirectory fd、返却fdの所有権をFileへ一度だけ渡す。
    let fd = unsafe {
      libc::openat(
        dir.as_raw_fd(),
        name.as_ptr(),
        flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
      )
    };
    if fd < 0 {
      return Err(io::Error::last_os_error());
    }
    // SAFETY: openatが返した新規の有効fdの所有権。
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata()?;
    if !private_file(&meta, uid()) {
      return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
  }
  fn existing_safe(dir: &File, name: &str) -> io::Result<()> {
    match open_at(dir, name, libc::O_RDONLY | libc::O_NONBLOCK) {
      Ok(_) => Ok(()),
      Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
      Err(error) => Err(error),
    }
  }
  fn unlink(dir: &File, name: &str) -> io::Result<()> {
    let name = CString::new(name).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: nameはNUL終端、dirはこの操作の間生存するdirectory fd。
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } == 0 {
      Ok(())
    } else {
      let error = io::Error::last_os_error();
      if error.kind() == io::ErrorKind::NotFound {
        Ok(())
      } else {
        Err(error)
      }
    }
  }
  pub(super) fn load(path: &Path, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    let result = (|| -> io::Result<Option<Secret>> {
      let dir = directory(path)?;
      let file = match open_at(&dir, kind.name(), libc::O_RDONLY | libc::O_NONBLOCK) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
      };
      let mut bytes = Zeroizing::new(Vec::new());
      file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
      if bytes.len() as u64 > MAX_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
      }
      std::str::from_utf8(&bytes)
        .map(|v| Some(Secret::new(v)))
        .map_err(|_| io::ErrorKind::InvalidData.into())
    })();
    result.map_err(|_| AccountError::Storage)
  }
  pub(super) fn save(path: &Path, kind: SecretKind, value: &Secret) -> Result<(), AccountError> {
    let result = (|| -> io::Result<()> {
      if value.expose().len() as u64 > MAX_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
      }
      let dir = directory(path)?;
      existing_safe(&dir, kind.name())?;
      let random = crate::connect::random_secret().map_err(|_| io::ErrorKind::Other)?;
      let name = format!(".{}.{}.tmp", kind.name(), random.expose());
      let result = (|| -> io::Result<()> {
        let mut file = open_at(&dir, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        file.write_all(value.expose().as_bytes())?;
        file.sync_all()?;
        existing_safe(&dir, kind.name())?;
        let from = CString::new(name.as_str()).map_err(|_| io::ErrorKind::InvalidInput)?;
        let to = CString::new(kind.name()).map_err(|_| io::ErrorKind::InvalidInput)?;
        // SAFETY: どちらもNUL終端の固定/生成ファイル名。同じ生存中のdirectory fd内でrenameする。
        if unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) } != 0 {
          return Err(io::Error::last_os_error());
        }
        dir.sync_all()
      })();
      if result.is_err() {
        let _ = unlink(&dir, &name);
      }
      result
    })();
    result.map_err(|_| AccountError::Storage)
  }
  pub(super) fn clear(path: &Path, kind: SecretKind) -> Result<(), AccountError> {
    let result = (|| -> io::Result<()> {
      let dir = directory(path)?;
      existing_safe(&dir, kind.name())?;
      unlink(&dir, kind.name())?;
      dir.sync_all()
    })();
    result.map_err(|_| AccountError::Storage)
  }
  #[cfg(test)]
  mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Temp(PathBuf);
    impl Temp {
      fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
          "niho-public-store-{}",
          crate::connect::random_secret().unwrap().expose()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
      }
      fn store(&self) -> FileSecretStore {
        FileSecretStore::in_data_dir(&self.0.join("public-v2")).unwrap()
      }
    }
    impl Drop for Temp {
      fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
      }
    }
    #[test]
    fn file_store_is_private_atomic_and_does_not_leave_temporary_files() {
      let temp = Temp::new();
      let store = temp.store();
      assert!(store.load(SecretKind::RefreshToken).unwrap().is_none());
      store
        .save(SecretKind::RefreshToken, &Secret::new("synthetic-first"))
        .unwrap();
      let dir = &store.dir;
      assert_eq!(fs::metadata(dir).unwrap().mode() & 0o777, 0o700);
      assert_eq!(fs::metadata(dir.join("refresh-token")).unwrap().mode() & 0o777, 0o600);
      // 本番atomic writerと同じopenat経路で一時ファイルの作成時から0600であることを検査。
      let handle = directory(dir).unwrap();
      let temporary = open_at(
        &handle,
        ".pending.synthetic.tmp",
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
      )
      .unwrap();
      assert_eq!(temporary.metadata().unwrap().mode() & 0o777, 0o600);
      drop(temporary);
      unlink(&handle, ".pending.synthetic.tmp").unwrap();
      store
        .save(SecretKind::RefreshToken, &Secret::new("synthetic-second"))
        .unwrap();
      assert!(store.load(SecretKind::RefreshToken).unwrap().unwrap().expose() == "synthetic-second");
      assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
      store.clear(SecretKind::RefreshToken).unwrap();
      store.clear(SecretKind::RefreshToken).unwrap();
    }
    #[test]
    fn symlinks_loose_parent_permissions_and_hardlinks_are_rejected() {
      let temp = Temp::new();
      let store = temp.store();
      store.save(SecretKind::Pending, &Secret::new("synthetic")).unwrap();
      let pending = store.dir.join("pending");
      fs::set_permissions(&pending, fs::Permissions::from_mode(0o644)).unwrap();
      assert_eq!(store.load(SecretKind::Pending).unwrap_err(), AccountError::Storage);
      assert_eq!(
        store
          .save(SecretKind::Pending, &Secret::new("replacement"))
          .unwrap_err(),
        AccountError::Storage
      );
      fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
      fs::hard_link(&pending, temp.0.join("linked")).unwrap();
      assert_eq!(store.load(SecretKind::Pending).unwrap_err(), AccountError::Storage);
      fs::remove_file(temp.0.join("linked")).unwrap();
      let parent = store.dir.parent().unwrap();
      fs::set_permissions(parent, fs::Permissions::from_mode(0o770)).unwrap();
      assert_eq!(store.load(SecretKind::Pending).unwrap_err(), AccountError::Storage);
      fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).unwrap();
      fs::remove_file(&pending).unwrap();
      symlink(temp.0.join("outside"), &pending).unwrap();
      assert_eq!(
        store
          .save(SecretKind::Pending, &Secret::new("replacement"))
          .unwrap_err(),
        AccountError::Storage
      );
      assert_eq!(store.clear(SecretKind::Pending).unwrap_err(), AccountError::Storage);
      fs::remove_file(&pending).unwrap();
      fs::remove_dir(&store.dir).unwrap();
      symlink(&temp.0, &store.dir).unwrap();
      assert_eq!(store.load(SecretKind::Pending).unwrap_err(), AccountError::Storage);
      let other = temp.0.join("parent-link");
      symlink(&temp.0, &other).unwrap();
      let linked = FileSecretStore::in_data_dir(&other.join("nested")).unwrap();
      assert_eq!(linked.load(SecretKind::Pending).unwrap_err(), AccountError::Storage);
    }
    #[test]
    fn owner_mismatch_is_rejected_before_any_secret_is_read() {
      let temp = Temp::new();
      let store = temp.store();
      store.save(SecretKind::Pending, &Secret::new("synthetic")).unwrap();
      let metadata = fs::metadata(store.dir.join("pending")).unwrap();
      assert!(private_file(&metadata, uid()));
      // chown権限を必要とせず、OSのstatを受ける所有者検証境界を異なるUIDで検査。
      assert!(!private_file(&metadata, uid().wrapping_add(1)));
    }
  }
}
#[cfg(unix)]
impl CredentialStore for FileSecretStore {
  fn load(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    files::load(&self.dir, kind)
  }
  fn save(&self, kind: SecretKind, value: &Secret) -> Result<(), AccountError> {
    files::save(&self.dir, kind, value)
  }
  fn clear(&self, kind: SecretKind) -> Result<(), AccountError> {
    files::clear(&self.dir, kind)
  }
}
#[cfg(not(unix))]
impl CredentialStore for FileSecretStore {
  fn load(&self, _: SecretKind) -> Result<Option<Secret>, AccountError> {
    let _ = &self.dir;
    Err(AccountError::Storage)
  }
  fn save(&self, _: SecretKind, _: &Secret) -> Result<(), AccountError> {
    Err(AccountError::Storage)
  }
  fn clear(&self, _: SecretKind) -> Result<(), AccountError> {
    Err(AccountError::Storage)
  }
}
pub struct KeychainStore {
  service: &'static str,
}
impl KeychainStore {
  pub fn photo() -> Self {
    Self {
      service: "life.niho.photo.public-app-connect.v2",
    }
  }
  pub fn docs() -> Self {
    Self {
      service: "life.niho.docs.public-app-connect.v2",
    }
  }
}
#[cfg(target_os = "macos")]
impl CredentialStore for KeychainStore {
  fn load(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    match generic_password(PasswordOptions::new_generic_password(self.service, kind.name())) {
      Ok(bytes) => {
        let bytes = Zeroizing::new(bytes);
        Ok(Some(Secret::new(
          std::str::from_utf8(&bytes).map_err(|_| AccountError::Storage)?,
        )))
      }
      Err(error) if error.code() == -25300 => Ok(None),
      Err(_) => Err(AccountError::Storage),
    }
  }
  fn save(&self, kind: SecretKind, value: &Secret) -> Result<(), AccountError> {
    security_framework::passwords::set_generic_password(self.service, kind.name(), value.expose().as_bytes())
      .map_err(|_| AccountError::Storage)
  }
  fn clear(&self, kind: SecretKind) -> Result<(), AccountError> {
    match security_framework::passwords::delete_generic_password(self.service, kind.name()) {
      Ok(()) => Ok(()),
      Err(error) if error.code() == -25300 => Ok(()),
      Err(_) => Err(AccountError::Storage),
    }
  }
}
#[cfg(not(target_os = "macos"))]
impl CredentialStore for KeychainStore {
  fn load(&self, _: SecretKind) -> Result<Option<Secret>, AccountError> {
    let _ = self.service;
    Err(AccountError::Storage)
  }
  fn save(&self, _: SecretKind, _: &Secret) -> Result<(), AccountError> {
    Err(AccountError::Storage)
  }
  fn clear(&self, _: SecretKind) -> Result<(), AccountError> {
    Err(AccountError::Storage)
  }
}
