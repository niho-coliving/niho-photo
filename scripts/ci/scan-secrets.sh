#!/usr/bin/env bash
set -euo pipefail
# 取得物のsha256は上流v8.24.3 release / configの実バイト列と照合済み。
scan_tmp="$(mktemp -d)"
trap 'rm -rf "$scan_tmp"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz \
  --output "$scan_tmp/gitleaks.tar.gz"
printf '%s  %s\n' '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c' "$scan_tmp/gitleaks.tar.gz" | sha256sum --check --status
curl --fail --silent --show-error --location --retry 3 \
  https://raw.githubusercontent.com/gitleaks/gitleaks/107a41827bb6698dbbff756b2300537774a1d84c/config/gitleaks.toml \
  --output "$scan_tmp/gitleaks.toml"
printf '%s  %s\n' '8f393899dbdc67e4eae580909e496acab9cf3a75aacfb6fac56b6eb16bb9e051' "$scan_tmp/gitleaks.toml" | sha256sum --check --status
tar --extract --gzip --file "$scan_tmp/gitleaks.tar.gz" --directory "$scan_tmp" gitleaks
# PR側の設定・ignore・allow commentでdefaultの検査範囲を狭めない。
"$scan_tmp/gitleaks" git --config "$scan_tmp/gitleaks.toml" --gitleaks-ignore-path "$scan_tmp/no-ignore" \
  --ignore-gitleaks-allow --redact=100 --no-banner --no-color --log-level error --log-opts='--all' .
printf '%s\n' 'Secret scan: 公開履歴の検査完了、検出なし'
