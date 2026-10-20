//! 利用者が始めた native の仕事（現像の準備・原寸の書き出し・保存など）の間、macOS の App Nap を止める（`NSProcessInfo` の
//! `beginActivityWithOptions:reason:`。公開 API）。
//!
//! 窓がほかのアプリの窓に隠れる・しまわれると、WindowServer がアプリを「見えない」とし、App Nap が入る（タイマーと CPU が
//! 絞られる）。すると sidecar の起動と終わりの確かめ（`packages/desktop-photo` の短い sleep の繰り返し）や、画面とのやり取りが
//! 数分止まる（E2E で確かめた: 原寸の書き出しの途中で窓が隠れると、次の sidecar の起動が 100 秒以上遅れた）。仕事の間だけ止め、
//! 終わってから少し（{@link GRACE}）持ち続けて、複数枚の書き出しの 1 枚ごとの合間（画面が次の 1 枚を頼むまで）でも切らない。

use std::sync::Mutex;
use std::time::Duration;

/// 仕事が終わってから App Nap を戻すまでの間（複数枚の書き出しの合間をつなぐ）。
pub const GRACE: Duration = Duration::from_secs(20);

struct State {
  /// 今の仕事の数
  holders: usize,
  /// 最後の仕事が終わるたびに進める（遅れて戻す thread が、その後に始まった仕事を見分ける）
  generation: u64,
  token: Option<platform::Token>,
}

static STATE: Mutex<State> = Mutex::new(State {
  holders: 0,
  generation: 0,
  token: None,
});

fn lock() -> std::sync::MutexGuard<'static, State> {
  STATE.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 仕事の印（Drop で手放す）。
#[must_use = "仕事の間持っておく"]
pub struct Hold(());

/// 仕事を始める（App Nap を止める）。
pub fn hold() -> Hold {
  let mut state = lock();
  state.holders += 1;
  if state.token.is_none() {
    state.token = platform::begin();
  }
  Hold(())
}

impl Drop for Hold {
  fn drop(&mut self) {
    let generation = {
      let mut state = lock();
      state.holders = state.holders.saturating_sub(1);
      if state.holders > 0 {
        return;
      }
      state.generation += 1;
      state.generation
    };
    // 少し待ってから、その間に次の仕事が始まっていなければ戻す（App Nap を止めている間なので、この待ちは絞られない）
    std::thread::spawn(move || {
      std::thread::sleep(GRACE);
      let token = {
        let mut state = lock();
        if state.holders > 0 || state.generation != generation {
          return;
        }
        state.token.take()
      };
      platform::end(token);
    });
  }
}

/// App Nap を止めているか（テスト用）。
#[cfg(test)]
pub fn is_holding() -> bool {
  lock().token.is_some()
}

#[cfg(target_os = "macos")]
mod platform {
  use objc2::rc::Retained;
  use objc2::runtime::ProtocolObject;
  use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

  /// `beginActivityWithOptions:reason:` の答え（`endActivity:` に渡し返す）。
  pub struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);
  // NSProcessInfo の activity はどの thread から始めて・終えてもよい（Foundation の thread-safe な API）
  unsafe impl Send for Token {}

  pub fn begin() -> Option<Token> {
    let reason = NSString::from_str("NIHO photo が写真を現像・書き出し中");
    // 利用者が始めた仕事: App Nap を止め、終わるまでアイドルのスリープも止める（終われば戻す）
    let activity =
      NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &reason);
    Some(Token(activity))
  }

  pub fn end(token: Option<Token>) {
    if let Some(Token(activity)) = token {
      unsafe { NSProcessInfo::processInfo().endActivity(&activity) };
    }
  }
}

#[cfg(not(target_os = "macos"))]
mod platform {
  pub struct Token;

  pub fn begin() -> Option<Token> {
    None
  }

  pub fn end(_token: Option<Token>) {}
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn app_nap_is_held_while_working_and_kept_for_a_while_after() {
    let first = hold();
    let second = hold();
    assert!(is_holding());
    drop(first);
    assert!(is_holding(), "ほかの仕事がある間は止めたまま");
    drop(second);
    assert!(is_holding(), "終わってすぐは戻さない（{GRACE:?} 持つ）");
    // 次の仕事がすぐ始まれば、同じ activity のまま続ける
    let third = hold();
    assert!(is_holding());
    drop(third);
  }
}
