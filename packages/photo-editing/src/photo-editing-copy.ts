/**
 * 写真編集の補正パネルまわりの利用者向けの文言（NIHO Photo 段 1 F0 移行元設計・F1 移行元設計）。共通の補正パネル（ブラウザと
 * NIHO Desktop）とブラウザ版の面はここから読む。補正の項目名（露光量など）は `photo-editing-adjustments.ts` の定義に、作業コピーを
 * 待つ間の 1 行は `develop-engine/develop-work-wait.ts` にある。
 */

/** 右パネルの見出し（NIHO Desktop。ブラウザ版は群名が見出しを兼ねる）。 */
export const PHOTO_EDITING_BASIC_ADJUSTMENTS_TITLE = "基本補正";
/** 補正を何も当てていない状態に戻す。 */
export const PHOTO_EDITING_RESET_LABEL = "初期化";
/** 「初期化」を押した後、その場所に出す 1 行（次の変更・取り消し・やり直し・写真を離れるまで）。 */
export const PHOTO_EDITING_RESET_DONE_TEXT = "初期化しました";
/** 「初期化」の直後に、初期化を取り消す（取り消すと同じ）。 */
export const PHOTO_EDITING_RESET_UNDO_LABEL = "元に戻す";
/** 絶対の白（撮影時の白がある写真）を撮影時の値に戻す。 */
export const PHOTO_EDITING_RESET_WHITE_BALANCE_LABEL = "撮影時に戻す";
/** 押している間だけ補正を外して見せる（写真の左上の札も同じ文言）。 */
export const PHOTO_EDITING_COMPARE_ORIGINAL_LABEL = "補正前";
/** 失敗した操作をその場でやり直す。 */
export const PHOTO_EDITING_RETRY_LABEL = "再試行";

/** 直前の補正の変更を取り消す / 取り消した変更をやり直す（ブラウザ版の右パネルの一番上の行）。 */
export const PHOTO_EDITING_UNDO_LABEL = "取り消す";
export const PHOTO_EDITING_REDO_LABEL = "やり直す";
/** ボタンの title（キーの案内）。 */
export const PHOTO_EDITING_UNDO_TITLE = "取り消す（⌘Z）";
export const PHOTO_EDITING_REDO_TITLE = "やり直す（⇧⌘Z）";

/** 補正の群の見出し（群の並びと項目は `PHOTO_EDITING_ADJUSTMENT_GROUPS`。Lightroom のクラウド版・モバイルと同じ）。 */
export const PHOTO_EDITING_LIGHT_GROUP_TITLE = "ライト";
export const PHOTO_EDITING_COLOR_GROUP_TITLE = "カラー";
export const PHOTO_EDITING_EFFECTS_GROUP_TITLE = "効果";

/**
 * ライトの群の見出しの横の「自動」（NIHO Photo 段 1 F4b 移行元設計。ブラウザ版で、口のある wasm で開いた写真だけ）。押すと明るさ
 * （ライト 6 本）と自然な彩度を写真に合わせて整え、押された表示のときにもう一度押すと押す前に戻す。`title` は読み上げ用の説明。
 */
export const PHOTO_EDITING_AUTO_LABEL = "自動";
export const PHOTO_EDITING_AUTO_TITLE = "明るさと色を自動で整える";
/** 「自動」を当てられなかったときの状態欄の 1 行（エラー）。 */
export const PHOTO_EDITING_AUTO_FAILED_TEXT = "自動補正ができませんでした";
/** ブラウザ版の右パネルの補正の面で、見出しの下に並べるチップ（自動 / 白黒。niho-photo#51）の読み上げ名。 */
export const PHOTO_EDITING_QUICK_ACTIONS_LABEL = "自動と白黒";

/** 効果の群名の横の ⓘ（押すと群の先頭に項目ごとの説明を出す）。 */
export const PHOTO_EDITING_EFFECTS_INFO_LABEL = "効果の説明";
export const PHOTO_EDITING_TEXTURE_DESCRIPTION = "細かな質感を強めたり、和らげたりします";
export const PHOTO_EDITING_CLARITY_DESCRIPTION = "中間の明暗の差を強めて、くっきり見せます";
export const PHOTO_EDITING_DEHAZE_DESCRIPTION = "かすみを取り除いたり、足したりします";

/**
 * 白黒・周辺光量補正・粒子（NIHO Photo 段 1 E1b 移行元設計）。効果のある設定（v: 3）を読める wasm で開いた写真にだけ出す。「白黒」は
 * カラーの群の先頭の切り替え、ほかは効果の群のスライダー（粒子のサイズは PC だけ）。説明は効果の ⓘ に 1 行ずつ。
 */
export const PHOTO_EDITING_GRAYSCALE_LABEL = "白黒";
export const PHOTO_EDITING_VIGNETTE_LABEL = "周辺光量補正";
export const PHOTO_EDITING_GRAIN_LABEL = "粒子";
export const PHOTO_EDITING_GRAIN_SIZE_LABEL = "粒子のサイズ";
export const PHOTO_EDITING_VIGNETTE_DESCRIPTION = "写真の四隅を暗くしたり、明るくしたりします";
export const PHOTO_EDITING_GRAIN_DESCRIPTION = "フィルムのような粒を足します";

/** スライダーの右の値を押して開く、値の直接入力の欄の読み上げ名。 */
export function photoEditingValueInputLabel(label: string): string {
  return `${label}の値`;
}

/** スライダーの右の値（押すと直接入力の欄に替わる）の読み上げ名。 */
export function photoEditingValueEditLabel(label: string, valueText: string): string {
  return `${label}の値 ${valueText} を入力`;
}

/** 右パネルの一番上の行の ⋯（補正のメニュー: コピー / 貼り付け。F5a-2 移行元設計）。 */
export const PHOTO_EDITING_SETTINGS_MENU_LABEL = "補正のメニュー";
export const PHOTO_EDITING_COPY_SETTINGS_LABEL = "補正をコピー";
export const PHOTO_EDITING_COPY_SETTINGS_SHORTCUT = {
  text: "⌥⇧⌘C",
  aria: "Alt+Shift+Meta+C Control+Alt+Shift+C",
} as const;
export const PHOTO_EDITING_PASTE_SETTINGS_LABEL = "補正を貼り付け";
export const PHOTO_EDITING_PASTE_SETTINGS_SHORTCUT = {
  text: "⌥⇧⌘V",
  aria: "Alt+Shift+Meta+V Control+Alt+Shift+V",
} as const;
/** 「補正をコピー」の後の状態欄。 */
export const PHOTO_EDITING_COPY_SETTINGS_DONE_TEXT = "補正をコピーしました";

/** ブラウザ版: 閲覧のみの operator の右パネルの 1 行。 */
export const BROWSER_PHOTO_EDITING_READ_ONLY_TEXT = "この拠点は閲覧のみです。";
/** ブラウザ版: 狭い幅で 1 枚を見ているときの状態欄。 */
export const BROWSER_PHOTO_EDITING_WIDE_ONLY_TEXT = "基本補正はPCで使えます";
/** ブラウザ版: 1 枚の面の下のフィルムストリップ（PC の広い幅。今の一覧のサムネイルの帯。L5 #54）の読み上げ名。 */
export const BROWSER_PHOTO_EDITING_FILMSTRIP_LABEL = "この一覧の写真";

/** 右パネルのプリセットの節（NIHO Photo 段 1 F2b 移行元設計）。 */
export const PHOTO_EDITING_PRESETS_TITLE = "プリセット";
/** プリセットを当てていない（一番上の行。選ばれているプリセットを外して、当てる前の補正に戻す）。 */
export const PHOTO_EDITING_PRESET_NONE_LABEL = "なし";
/** ブラウザ版の補正の面のプリセットの行（niho-photo#51）: 今のプリセット名のボタン（押すとプリセットの面を開く）の読み上げ名。 */
export function photoEditingPresetCurrentLabel(presetName: string): string {
  return `プリセット: ${presetName}`;
}
/** 同じ行の右端の、プリセットの面を開くボタンの読み上げ名。 */
export const PHOTO_EDITING_PRESETS_OPEN_PANEL_LABEL = "プリセットの一覧";

/**
 * スマホ（1024px 未満）の 1 枚の編集の層（NIHO Photo 段 1 F6c 移行元設計・モック `idea/mock/photo-editing-mobile-v1.html`）。
 * 取り消す・やり直す・補正前・初期化・撮影時に戻す・再試行は上の定数を、プリセット名は右パネルと同じ定数を使い回す。
 */
/** 層の読み上げ名。 */
export const PHOTO_EDITING_MOBILE_EDITOR_LABEL = "写真の編集";
/** 上の帯の ‹（一覧へ戻る）の読み上げ名。 */
export const PHOTO_EDITING_MOBILE_BACK_LABEL = "写真の一覧に戻る";
/** 道具の帯（プリセット／ライト／カラー／効果）の読み上げ名。 */
export const PHOTO_EDITING_MOBILE_TOOLS_LABEL = "道具";
/** プリセットの道具と一覧の読み上げ名。 */
export const PHOTO_EDITING_MOBILE_PRESETS_LABEL = PHOTO_EDITING_PRESETS_TITLE;
/** プリセットを外す選択肢。 */
export const PHOTO_EDITING_MOBILE_PRESET_NONE_LABEL = PHOTO_EDITING_PRESET_NONE_LABEL;
/** 段 A（今の道具の項目のチップの帯）の読み上げ名。 */
export function photoEditingMobileItemsLabel(groupTitle: string): string {
  return `${groupTitle}の項目`;
}
/** プリセットの段: 一覧を読めなかったときの状態の 1 行と、その場で読み直す文字ボタン。 */
export const PHOTO_EDITING_MOBILE_PRESETS_LOAD_FAILED_TEXT = "プリセットを読み込めませんでした";
export const PHOTO_EDITING_MOBILE_PRESETS_RELOAD_LABEL = "もう一度読み込む";
/** 主ボタンと、下から出るシートの見出し・読み上げ名。 */
export const PHOTO_EDITING_EXPORT_LABEL = "書き出す";
/** シートの大きさの群の見出し（長辺 2048px / 幅 1080px。F7b 移行元設計）。 */
export const PHOTO_EDITING_EXPORT_SIZE_LABEL = "大きさ";
/** シートの形式の群の見出し。 */
export const PHOTO_EDITING_EXPORT_FORMAT_LABEL = "形式";
export const PHOTO_EDITING_EXPORT_JPEG_LABEL = "JPEG";
/** 形式の PNG（背景除去を重ねている写真だけ。NIHO camera。C4 移行元設計）。 */
export const PHOTO_EDITING_EXPORT_PNG_LABEL = "PNG";
export const PHOTO_EDITING_EXPORT_ORIGINAL_LABEL = "オリジナル";
/** シートの主ボタン: オリジナル（と、共有シートも端末の保存も無い環境の JPEG）。PC のシートと同じ。 */
export const PHOTO_EDITING_EXPORT_DOWNLOAD_LABEL = "ダウンロード";
/**
 * 大きさの「原寸」（NIHO Desktop だけ。K2-3a 移行元設計）: カードの名前と副文、選んだときの主ボタン（ネイティブの保存ダイアログを出す）、
 * 形式の下の 1 行（保存先を選んでから描く・かかる時間の目安）。
 */
export const PHOTO_EDITING_EXPORT_FULL_SIZE_LABEL = "原寸";
export const PHOTO_EDITING_EXPORT_FULL_SIZE_DETAIL = "この Mac に保存";
export const PHOTO_EDITING_EXPORT_SAVE_LABEL = "保存";
export const PHOTO_EDITING_EXPORT_FULL_SIZE_TEXT = "保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。";
/** 「原寸」を押せない理由: NIHO Desktop の原寸の書き出しが描けない形式（HEIC / HEIF・TIFF。Desktop の `unsupportedSource`）。 */
export const PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_TEXT = "HEIC・TIFF は対応していません";
/**
 * 原寸の書き出しが形式（HEIC / TIFF）を断ったときの失敗の 1 行（複数枚をフォルダへ書き出すとき、Desktop へ落とす前に同じ文で
 * 失敗にする。NIHO Desktop の `unsupportedSource` の文も同じ定数）。
 */
export const PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_FAILED_TEXT = "HEIC・TIFF の写真は、この書き出しに対応していません。";
/** 原寸の書き出しが失敗し、Desktop の理由を画面に出せないとき（英語の文など）。 */
export const PHOTO_EDITING_EXPORT_FULL_SIZE_FAILED_TEXT = "原寸の JPEG を書き出せませんでした。もう一度お試しください。";
/** 保存した土台を復元できない旧 Desktop では、オリジナルを落とす前に既存の状態欄へ出す。 */
export const PHOTO_EDITING_EXPORT_FULL_SIZE_UPDATE_TEXT = "NIHO Desktop を更新すると、原寸で書き出せます。";
/**
 * 複数枚の「フォルダへ原寸で書き出す」（NIHO Desktop だけ。K2-3b 移行元設計）: 主ボタン（ネイティブのフォルダの選択を出す）と、
 * 形式の下の 1 行（ZIP のシートの「選んだ N 枚を ZIP にまとめます。」と同じ形に、原寸の 1 枚あたりの時間の目安を添える）。
 */
export const PHOTO_EDITING_EXPORT_TO_FOLDER_LABEL = "フォルダに書き出す";
export function photoEditingBatchFolderExportText(count: number): string {
  return `選んだ ${count} 枚を、選ぶフォルダへ原寸で書き出します（24MP で 1 枚 10 秒ほど）。`;
}
/**
 * NIHO Desktop で ZIP を作れない案内（「ZIP はブラウザで保存できます」）の、フォルダへの書き出しが出るときの文（K2-3b 移行元設計）。
 * 複数枚のシートでオリジナルを押せない理由に出し、代わりにできること（原寸の JPEG をフォルダへ）を添える。
 */
export const PHOTO_EDITING_BATCH_EXPORT_FOLDER_HINT_TEXT = "ZIP はブラウザで保存できます。フォルダへは原寸の JPEG で書き出せます";
/** フォルダへの書き出しを止めたとき（ZIP の「N 枚を ZIP にまとめて停止しました」「書き出しを停止しました」と同じ形）。 */
export function photoEditingFolderExportStoppedText(savedCount: number): string {
  return savedCount > 0 ? `${savedCount} 枚を書き出して停止しました` : "書き出しを停止しました";
}
/** フォルダへ書き出せなかった写真の件数（状態欄で書き出した枚数の後ろに足す・知らせの見出し。ZIP と同じ数え方）。 */
export function photoEditingExportFailedCountText(failedCount: number): string {
  return `${failedCount} 枚を書き出せませんでした`;
}
/** シートの主ボタン: 書き出している間。 */
export const PHOTO_EDITING_EXPORTING_LABEL = "書き出し中…";
/** 描き終えたが共有シートを出せなかった（押してから時間が経った）。同じボタンをもう一度押してもらう。 */
export const PHOTO_EDITING_EXPORT_READY_TEXT = "準備ができました。もう一度押してください";
export const PHOTO_EDITING_CLOSE_LABEL = "閉じる";
/** シートの形式の下の 1 行: JPEG（段 2 の wasm と、原寸の NIHO Desktop の native の段 2 で描くとき）は撮影日時だけの EXIF を付ける。 */
export const PHOTO_EDITING_EXPORT_CAPTURE_EXIF_TEXT = "撮影日時を付けます。位置情報は付けません。";
/** シートの形式の下の 1 行: オリジナル。 */
export const PHOTO_EDITING_EXPORT_ORIGINAL_TEXT = "オリジナルをそのまま保存します。";
/**
 * 背景除去を重ねている写真の書き出し（NIHO camera だけ。C4 移行元設計）: JPEG と PNG の副文、形式の下の 1 行（PNG は EXIF を
 * 付けない。背景が透明なら透明のまま保存すること。JPEG は透明を持てないので、透明の背景は白にすること）、PNG を書き出せなかったとき。
 */
export const PHOTO_EDITING_EXPORT_CUTOUT_DETAIL = "背景除去を反映";
export const PHOTO_EDITING_EXPORT_PNG_NO_EXIF_TEXT = "撮影日時は付けません。";
export const PHOTO_EDITING_EXPORT_PNG_TEXT = `背景の透明をそのまま保存します。${PHOTO_EDITING_EXPORT_PNG_NO_EXIF_TEXT}`;
export const PHOTO_EDITING_EXPORT_CUTOUT_WHITE_TEXT = "透明の背景は白にします。";
export const PHOTO_EDITING_EXPORT_PNG_FAILED_TEXT = "PNG を書き出せませんでした。もう一度お試しください。";
/** 一覧から JPEG を描こうとして、段 2 の wasm を用意できなかった（次は記事用の画像か、押せない理由を出す）。 */
export const PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT = "JPEG を書き出す準備ができませんでした。もう一度お試しください。";
/** 一覧から JPEG を描こうとして、新しい版の NIHO で補正された写真だと分かった。 */
export const PHOTO_EDITING_EXPORT_NEWER_TEXT = "新しい版の NIHO で補正された写真です。ページを読み込み直すと書き出せます。";
/**
 * 幅 1080px を選んだが、写真が小さくて届かなかった（拡大はしない）ときに状態欄の 1 行の後ろに足す（例:
 * 「A.jpg をダウンロードしました（幅 1024px。小さい写真は拡大しません）」）。
 */
export function photoEditingExportNarrowNote(width: number): string {
  return `（幅 ${width}px。小さい写真は拡大しません）`;
}
/** 保存し終えたときの状態欄（「写真に保存しました」「端末に保存しました」）。`actionLabel` は主ボタンの文言。 */
export function photoEditingSavedText(actionLabel: string): string {
  return `${actionLabel}しました`;
}

/**
 * NIHO Desktop の面: 切り抜き・回転のある写真（`developSettings` v2。移行元設計）は、幾何を描けないこの面では閲覧だけ。直すのは
 * ブラウザ版の面（K2 移行元設計 で NIHO Desktop も同じ面になる）。
 */
export const PHOTO_EDITING_GEOMETRY_DESKTOP_LOCKED_MESSAGE =
  "切り抜き・回転した写真は、この画面では見るだけです。現行版ではブラウザ版でも修正できないため、修正が必要な場合はNIHOにご相談ください。";
/**
 * ブラウザ版: 直している写真を、別の端末が先に保存した補正で読み直したときの状態欄の 1 行（情報。版の照合 移行元設計。取り消しの
 * 履歴は捨て、読み込んだ補正から始め直す）。
 */
export const BROWSER_PHOTO_EDITING_DEVELOP_RELOADED_TEXT = "別の端末で直した補正を読み込みました";
/** ブラウザ版: 409 後、別の端末が保存した補正を読み直している間の状態欄の 1 行。 */
export const BROWSER_PHOTO_EDITING_DEVELOP_RELOADING_TEXT = "別の端末で保存された補正を読み込んでいます";

/** 拠点で取り込んだプリセットの小見出し。 */
export const PHOTO_EDITING_SPOT_PRESETS_TITLE = "拠点のプリセット";
/** プリセットの行にマウスを載せている間、写真の左上に出す札。 */
export function photoEditingPresetPreviewLabel(presetName: string): string {
  return `${presetName} のプレビュー`;
}
/** Lightroom のプリセット（.xmp・.dng）を拠点に取り込む。 */
export const PHOTO_EDITING_PRESET_IMPORT_LABEL = "取り込む";
export const PHOTO_EDITING_PRESET_IMPORTING_LABEL = "取り込み中...";
/** 拠点のプリセットの行の削除ボタンの読み上げ名。 */
export function photoEditingPresetDeleteLabel(presetName: string): string {
  return `${presetName} を削除`;
}

/** 選ばれているプリセットの適用量（0〜150%。ブラウザ版の右パネル。F2b 移行元設計）。 */
export const PHOTO_EDITING_PRESET_AMOUNT_LABEL = "適用量";
/** ブラウザ版のプリセットの節の見出しの右の「⋯」（メニューを開く）の読み上げ名と、その項目。 */
export const PHOTO_EDITING_PRESET_ACTIONS_LABEL = "プリセットの操作";
export const PHOTO_EDITING_PRESET_SAVE_CURRENT_LABEL = "今の補正をプリセットに保存";
export const PHOTO_EDITING_PRESET_IMPORT_MENU_LABEL = "Lightroom のプリセットを取り込む（.xmp・.dng）";
/** 拠点のプリセットの行の右の「⋯」の読み上げ名と、その項目。 */
export function photoEditingPresetRowActionsLabel(presetName: string): string {
  return `${presetName} の操作`;
}
export const PHOTO_EDITING_PRESET_RENAME_LABEL = "名前を変更";
export const PHOTO_EDITING_PRESET_DELETE_MENU_LABEL = "削除";
/** 「今の補正をプリセットに保存」・「名前を変更」のダイアログ。 */
export const PHOTO_EDITING_PRESET_NAME_LABEL = "プリセットの名前";
export const PHOTO_EDITING_PRESET_INCLUDE_EXPOSURE_LABEL = "露光量を含める";
export const PHOTO_EDITING_PRESET_INCLUDE_WHITE_BALANCE_LABEL = "ホワイトバランスを含める";
export const PHOTO_EDITING_PRESET_CROP_NOT_SAVED_TEXT = "切り抜きはプリセットに入りません。";
export const PHOTO_EDITING_PRESET_NEUTRAL_SAVE_TEXT = "補正を当ててから保存できます。";
/**
 * 拠点のプリセットの名前の変更・「今の補正をプリセットに保存」で、同じ名前があったとき（入力の下に出す。移行元設計 で web の
 * photo-presets-admin から移した。API の失敗の文と同じ文を使う）。
 */
export const PHOTO_PRESET_NAME_TAKEN_RENAME_MESSAGE = "同じ名前のプリセットがあります。別の名前にしてください。";
/** 取り込む XMP が大きすぎる（512KB を超える。API の上限と同じ）。 */
export const PHOTO_PRESET_XMP_TOO_LARGE_MESSAGE =
  "XMP が 512KB を超えています。Lightroom から書き出し直した XMP を選んでください。";
/** 取り込むファイルが Lightroom のプリセット（XMP）でない。 */
export const PHOTO_PRESET_XMP_INVALID_MESSAGE =
  "Lightroom のプリセット（XMP）ではありません。.xmp のファイルを選んでください。";
export const PHOTO_EDITING_PRESET_SAVE_LABEL = "保存";
export const PHOTO_EDITING_PRESET_SAVING_LABEL = "保存中...";
export const PHOTO_EDITING_PRESET_RENAME_CONFIRM_LABEL = "変更";
export const PHOTO_EDITING_PRESET_RENAMING_LABEL = "変更中...";
export const PHOTO_EDITING_PRESET_DIALOG_CANCEL_LABEL = "やめる";
/** 名前が長すぎる（前後の空白を除いた文字数）。 */
export function photoEditingPresetNameTooLongText(maxChars: number): string {
  return `名前は ${maxChars} 文字以内にしてください。`;
}
/** 今の補正を XMP に書き出せなかった（wasm の失敗。保存はしていない）。 */
export const PHOTO_EDITING_PRESET_WRITE_ERROR =
  "今の補正をプリセットにできませんでした。ページを読み込み直して、もう一度お試しください。";
/** プリセット形式で表せない項目があり、XMPへ一部を落とす必要があるときは保存しない。 */
export function photoEditingPresetNotWrittenError(fields: readonly string[]): string {
  const labels: Record<string, string> = {
    whiteBalance: "ホワイトバランス",
    relativeTemperature: "相対の色温度",
    relativeTint: "相対の色かぶり補正",
    legacySettings: "未対応の補正",
  };
  const names = Array.from(new Set(fields.map((field) => labels[field] ?? "未対応の補正")));
  return `プリセットに保存できない補正があります（${names.join("・")}）。対象の補正を外してから、もう一度保存してください。`;
}
export const PHOTO_EDITING_PRESET_RENAME_ERROR =
  "名前を変更できませんでした。通信を確かめて、もう一度お試しください。";

/** 取り込めなかった理由（DNG）。 */
export const PHOTO_EDITING_PRESET_DNG_TOO_LARGE_MESSAGE =
  "DNG が 100MB を超えています。Lightroom から書き出し直したプリセットを選んでください。";
export const PHOTO_EDITING_PRESET_DNG_NO_XMP_MESSAGE = "このファイルにはプリセットが入っていません";

/** 取り込んだプリセットのうち、NIHO が使えない項目の知らせ（情報の 1 行。`items` は「シャープ・ノイズ軽減」の形）。 */
export function photoEditingPresetImportPartialText(items: string): string {
  return `${items}は使えないので、それ以外を取り込みました`;
}
/** 使えない項目のうち、名前の表に無いものの数え方（名前のある項目に続けるときは「ほか」を付ける）。 */
export function photoEditingPresetOtherItemsText(count: number, afterNamedItems: boolean): string {
  return afterNamedItems ? `ほか ${count} 項目` : `${count} 項目`;
}
/** 使えない項目の名前の区切り。 */
export const PHOTO_EDITING_PRESET_ITEM_SEPARATOR = "・";

/** Lightroom 専用の色の表（プロファイルの LUT）を使うプリセットを取り込む前の確認。 */
export function photoEditingPresetColorTableConfirmTitle(fileName: string): string {
  return `「${fileName}」を取り込みますか？`;
}
export const PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_DESCRIPTION =
  "このプリセットは Lightroom 専用の色の表を使っているので、同じ見た目にはなりません。";
export const PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_LABEL = "取り込む";
export const PHOTO_EDITING_PRESET_COLOR_TABLE_CANCEL_LABEL = "やめる";

/**
 * プリセットが持つ項目のうち NIHO が使えないものの、Lightroom の日本語の名前（対応する XMP の項目は
 * `photo-preset-xmp-support.ts`）。
 */
export const PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS = {
  sharpen: "シャープ",
  noiseReduction: "ノイズ軽減",
  colorNoiseReduction: "カラーノイズの軽減",
  chromaticAberration: "色収差の除去",
  defringe: "フリンジ軽減",
  lensCorrection: "レンズ補正",
  incrementalWhiteBalance: "色温度・色かぶり補正",
  blackAndWhite: "白黒",
  vignette: "周辺光量補正",
  grain: "粒子",
  colorGradeLuminance: "カラーグレーディングの輝度",
  curveSaturation: "トーンカーブの彩度",
  transform: "変形",
  profile: "プロファイル",
} as const;
/** ブラウザ版の右パネルの一番上の道具の切り替え（補正 / 切り抜き。NIHO Photo 段 1 F3b 移行元設計）。 */
export const PHOTO_EDITING_TOOL_GROUP_LABEL = "編集の道具";
export const PHOTO_EDITING_TOOL_ADJUST_LABEL = "補正";
export const PHOTO_EDITING_TOOL_CROP_LABEL = "切り抜き";
export const PHOTO_EDITING_TOOL_CUTOUT_LABEL = "背景除去";
/**
 * ブラウザ版の右端の道具の帯（niho-photo#51。Lightroom と同じく、押した道具で右パネルを丸ごと入れ替える）の読み上げ名。
 * 道具の名前は プリセット（`PHOTO_EDITING_PRESETS_TITLE`）と上の 補正 / 切り抜き / 背景除去。
 */
export const PHOTO_EDITING_TOOL_RAIL_LABEL = "道具";

/**
 * 背景除去の道具（NIHO camera だけ。`capabilities.cutout`。C4 移行元設計）。推論はこの Mac の中（Apple Vision）。
 * 背景除去と切り抜き・回転は同時に使わない（使えない側の道具に理由と次の一歩を 1 行出す）。
 */
export const PHOTO_EDITING_CUTOUT_RUN_LABEL = "背景を除去";
export const PHOTO_EDITING_CUTOUT_RUN_HINT = "写真の中の人や物を見つけて、背景を透明にします。写真はこの Mac の外へ送りません。";
export const PHOTO_EDITING_CUTOUT_RUNNING_TEXT = "人や物を探しています…";
export const PHOTO_EDITING_CUTOUT_CANCEL_LABEL = "やめる";
export const PHOTO_EDITING_CUTOUT_SUBJECT_TITLE = "被写体";
export const PHOTO_EDITING_CUTOUT_SUBJECT_ALL_LABEL = "すべて";
export const PHOTO_EDITING_CUTOUT_BACKGROUND_TITLE = "背景";
export const PHOTO_EDITING_CUTOUT_BACKGROUND_TRANSPARENT_LABEL = "透明";
export const PHOTO_EDITING_CUTOUT_BACKGROUND_WHITE_LABEL = "白";
export const PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_LABEL = "色";
export const PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_PICKER_LABEL = "背景の色";
export const PHOTO_EDITING_CUTOUT_BRUSH_TITLE = "ブラシ";
export const PHOTO_EDITING_CUTOUT_BRUSH_ERASE_LABEL = "消す";
export const PHOTO_EDITING_CUTOUT_BRUSH_RESTORE_LABEL = "戻す";
export const PHOTO_EDITING_CUTOUT_BRUSH_SIZE_LABEL = "ブラシの大きさ";
export const PHOTO_EDITING_CUTOUT_BRUSH_HINT = "写真をなぞると、残ったところを消したり、消えたところを戻したりできます。";
/** 写真の上のブラシの面の読み上げ名。 */
export const PHOTO_EDITING_CUTOUT_BRUSH_AREA_LABEL = "背景除去のブラシ";
export const PHOTO_EDITING_CUTOUT_REMOVE_LABEL = "背景除去を外す";
/** レシピを保存できなかったとき（状態欄に 1 行。次に保存できたら消す）。 */
export const PHOTO_EDITING_CUTOUT_SAVE_FAILED_TEXT = "背景除去を保存できませんでした。";
export const PHOTO_EDITING_CUTOUT_BLOCKED_BY_GEOMETRY_TEXT = "切り抜き・回転をした写真では背景を除去できません。切り抜きを初期化すると使えます。";
export const PHOTO_EDITING_CROP_BLOCKED_BY_CUTOUT_TEXT = "背景を除去した写真は切り抜けません。背景除去を外すと切り抜けます。";

/** 被写体の選択肢の名前（並びは `cutoutSubjectChoices`。1 番目が面積の最大）。 */
export function photoEditingCutoutSubjectLabel(selection: string, order: number): string {
  return selection === "all" ? PHOTO_EDITING_CUTOUT_SUBJECT_ALL_LABEL : `被写体 ${order}`;
}

/** sidecar の失敗の `error`（README「機械が読む契約」）から、状態と次の一歩の 1 行。 */
export function photoEditingCutoutFailureText(code: string): string {
  switch (code) {
    case "no_subjects":
      return "切り抜ける人や物が見つかりませんでした。";
    case "engine_failed":
      return "この Mac では背景を除去できませんでした。";
    case "input_unreadable":
    case "invalid_image":
      return "写真を読めませんでした。";
    case "corrupt_mask":
    case "mask_mismatch":
      return "保存していた背景除去を読めませんでした。もう一度「背景を除去」を押してください。";
    default:
      return "背景を除去できませんでした。もう一度お試しください。";
  }
}

/** 切り抜きの道具（縦横比・角度補正・90° 回転・左右の反転）。 */
export const PHOTO_EDITING_CROP_ASPECT_TITLE = "縦横比";
export const PHOTO_EDITING_CROP_ASPECT_ORIGINAL_LABEL = "元の比率";
export const PHOTO_EDITING_CROP_ASPECT_FREE_LABEL = "自由";
export const PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL = "縦横の入れ替え";
export const PHOTO_EDITING_CROP_ANGLE_LABEL = "角度補正";
export const PHOTO_EDITING_CROP_ROTATE_LABEL = "90° 回転";
export const PHOTO_EDITING_CROP_FLIP_LABEL = "左右の反転";

/** 写真の上の切り抜きの枠と、そのつまみ（角 4・辺 4。枠がまっすぐ立って見える向きで）の読み上げ名。 */
export const PHOTO_EDITING_CROP_FRAME_LABEL = "切り抜きの枠";
export const PHOTO_EDITING_CROP_HANDLE_LABELS = {
  nw: "左上の角",
  n: "上の辺",
  ne: "右上の角",
  e: "右の辺",
  se: "右下の角",
  s: "下の辺",
  sw: "左下の角",
  w: "左の辺",
} as const;

function formatPhotoEditingPixels(value: number): string {
  return Math.round(value).toLocaleString("ja-JP");
}

/** 切り抜きで書き出しが長辺 2048px に届かなくなるときの 1 行。 */
export function photoEditingCropExportLimitText(longEdge: number): string {
  return `書き出しは長辺 ${formatPhotoEditingPixels(longEdge)}px まで`;
}

/** 切り抜きを確定するたびに読み上げる、今の切り抜きの大きさ。 */
export function photoEditingCropSizeText(width: number, height: number): string {
  return `切り抜き ${formatPhotoEditingPixels(width)} × ${formatPhotoEditingPixels(height)}`;
}

/**
 * ブラウザ版の一覧の複数選択（F5a-2 移行元設計）。スマホの上の行の「選択」ボタンと、複数を選んでいる間の選択バー
 * （「N 枚を選択」・［すべて］・［キャンセル］）。
 */
export const PHOTO_EDITING_SELECT_LABEL = "選択";
export const PHOTO_EDITING_SELECT_ALL_LABEL = "すべて";
export const PHOTO_EDITING_SELECT_CANCEL_LABEL = "キャンセル";
/** 選んでいる枚数（数字と「枚」の間は半角スペース 1 つ。0 枚のときも「0 枚を選択」）。 */
export function photoEditingSelectionCountText(count: number): string {
  return `${count} 枚を選択`;
}

/**
 * ブラウザ版の一覧で選んだ複数枚への一括の補正（F5a-2 移行元設計）。PC のブラウザ版の選択バーの「補正」メニューと、一覧を見ている間の
 * ⌥⇧⌘C / ⌥⇧⌘V。状態欄の文は件数が 0 の項目を出さない。内部の状態（`queued` など）・英語の識別子は出さない（Epic 移行元設計
 * 決めごと 6。Lightroom のクラウド版・モバイルの語彙）。
 */
/** 選択バーの文字ボタン（押すと下にメニュー）。 */
export const PHOTO_EDITING_BULK_MENU_LABEL = "補正";
/** 処理中の同じ場所のボタン（押すと、走っている写真を終えてから止める）。 */
export const PHOTO_EDITING_BULK_STOP_LABEL = "止める";
export const PHOTO_EDITING_BULK_STOPPING_LABEL = "停止中…";
/** 一括の終わりの状態欄の 1 行の後ろ（当てる前の補正に戻す。次の操作・選択の変更・写真を開く・一覧を離れるまで）。 */
export const PHOTO_EDITING_BULK_UNDO_LABEL = PHOTO_EDITING_RESET_UNDO_LABEL;
/** メニューの「補正を貼り付け」を押せない理由（何もコピーしていない）。キーで貼り付けようとしたときの状態欄も同じ。 */
export const PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT = "先に 1 枚の補正をコピーしてください";
/** メニューのプリセットを読んでいる間・読めなかったとき。 */
export const PHOTO_EDITING_BULK_PRESETS_LOADING_TEXT = "プリセットを読み込み中…";
export const PHOTO_EDITING_BULK_PRESETS_FAILED_TEXT = "プリセットを読み込めませんでした。メニューを開き直してください。";
/** 一覧で ⌥⇧⌘C: 1 枚だけ選んでいないとき・補正を保存していない写真・読めない版の補正の写真。 */
export const PHOTO_EDITING_BULK_COPY_NEEDS_ONE_TEXT = "補正をコピーするには、写真を 1 枚だけ選んでください。";
export const PHOTO_EDITING_BULK_COPY_NO_SETTINGS_TEXT = "この写真には保存した補正がありません。";
export const PHOTO_EDITING_BULK_COPY_UNREADABLE_TEXT = "新しい版の NIHO で補正された写真なので、コピーできません。";
/** 一覧で ⌥⇧⌘V: 何も選んでいないとき。 */
export const PHOTO_EDITING_BULK_PASTE_NEEDS_SELECTION_TEXT = "貼り付ける写真を選んでください。";
/** 一括で当てられなかった（engine を用意できない・プリセットを当てられない・始める前の保存の送り終えに失敗）。 */
export const PHOTO_EDITING_BULK_ENGINE_UNAVAILABLE_TEXT = "プリセットを当てる準備ができませんでした。ページを読み込み直してください。";
export const PHOTO_EDITING_BULK_FAILED_TEXT = "補正を当てられませんでした。もう一度お試しください。";
export function photoEditingBulkPresetUnusableText(name: string): string {
  return `プリセット「${name}」は当てられませんでした。`;
}

/** 一括の中身（状態欄の文を選ぶ）。 */
export type PhotoEditingBulkAction = { kind: "paste" } | { kind: "preset"; name: string };

/** 一括の間の進み具合（状態欄）。 */
export function photoEditingBulkProgressText(action: PhotoEditingBulkAction, done: number, total: number): string {
  return action.kind === "paste"
    ? `補正を貼り付けています（${done} / ${total}）`
    : `プリセット「${action.name}」を当てています（${done} / ${total}）`;
}

/** 元に戻している間の進み具合（状態欄）。 */
export function photoEditingBulkUndoProgressText(done: number, total: number): string {
  return `補正を元に戻しています（${done} / ${total}）`;
}

/** 一括の終わりの状態欄の 1 行（保存できなかった写真があれば error。選択は残して再試行できる）。 */
export function photoEditingBulkResultStatus(params: {
  action: PhotoEditingBulkAction;
  counts: { applied: number; preparing: number; locked: number; unchanged: number; stale: number; failed: number };
  lockedReasons?: {
    unsupported: number;
    base_mismatch: number;
    base_unavailable: number;
    reader_incompatible: number;
  };
  stopped: boolean;
}): { kind: "notice" | "error"; text: string } {
  const { action, counts, lockedReasons, stopped } = params;
  const parts: string[] = [];
  if (stopped) {
    parts.push(counts.applied > 0 ? `${counts.applied} 枚に当てて止めました。` : "当てる前に止めました。");
  } else if (counts.applied > 0) {
    parts.push(
      action.kind === "paste"
        ? `${counts.applied} 枚に貼り付けました。`
        : `${counts.applied} 枚にプリセット「${action.name}」を当てました。`,
    );
  } else if (counts.failed === 0) {
    parts.push("当てられる写真がありませんでした。");
  }
  if (counts.stale > 0) parts.push(`${counts.stale} 枚は別の端末で直されていたので飛ばしました。`);
  if (counts.preparing > 0) parts.push(`準備中の ${counts.preparing} 枚には当てていません。`);
  const reloadRequired = (lockedReasons?.base_mismatch ?? 0) + (lockedReasons?.reader_incompatible ?? 0);
  const baseUnavailable = lockedReasons?.base_unavailable ?? 0;
  const describedLocked = reloadRequired + baseUnavailable;
  if (reloadRequired > 0) parts.push(`読み込み直しが必要な ${reloadRequired} 枚には当てていません。ページを読み込み直してください。`);
  if (baseUnavailable > 0) {
    parts.push(`保存した編集元を復元できない ${baseUnavailable} 枚には当てていません。元の写真から復元してください。`);
  }
  if (counts.locked > describedLocked) parts.push(`補正できない ${counts.locked - describedLocked} 枚には当てていません。`);
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} 枚はすでに同じ補正でした。`);
  if (counts.failed > 0) parts.push(`保存できなかった写真が ${counts.failed} 枚あります。もう一度お試しください。`);
  return { kind: counts.failed > 0 ? "error" : "notice", text: parts.join("") };
}

/** 元に戻した後の状態欄の 1 行（「N 枚を元に戻しました（…）」。戻せなかった写真があれば error）。 */
export function photoEditingBulkUndoResultStatus(params: {
  counts: { undone: number; stale: number; failed: number };
  stopped: boolean;
}): { kind: "notice" | "error"; text: string } {
  const { counts, stopped } = params;
  const notes: string[] = [];
  if (counts.stale > 0) notes.push(`${counts.stale} 枚はその後に直されていたので戻していません`);
  if (counts.failed > 0) notes.push(`${counts.failed} 枚は保存できなかったので戻せていません`);
  const detail = notes.length > 0 ? `（${notes.join("。")}）` : "";
  const head = stopped
    ? `${counts.undone} 枚を元に戻して止めました`
    : counts.undone > 0
      ? `${counts.undone} 枚を元に戻しました`
      : "元に戻せる写真がありませんでした";
  return { kind: counts.failed > 0 ? "error" : "notice", text: `${head}${detail}。` };
}

/**
 * この Mac のフォルダの面（写真の出どころに `folders` があるときだけ。NIHO camera C3 移行元設計）。左の木の見出し・パンくずの先頭は
 * 「この Mac」。フォルダを足すのは見出しの「＋」と空状態の主ボタン、外すのは根のフォルダの「⋯」の「一覧から外す」（フォルダと
 * 写真は消さない）。
 */
export const PHOTO_EDITING_LOCAL_PLACE_LABEL = "この Mac";
/** 見出しの「＋」の読み上げ名・空状態の見出しと主ボタン。 */
export const PHOTO_EDITING_ADD_FOLDER_LABEL = "フォルダを追加";
export const PHOTO_EDITING_ADD_SELECTED_PHOTOS_LABEL = "写真を選ぶ";
export const PHOTO_EDITING_SELECTED_PHOTOS_LABEL = "選んだ写真";
/** フォルダが 1 つも無いときの空状態の本文。 */
export const PHOTO_EDITING_ADD_FOLDER_EMPTY_TEXT =
  "写真のあるフォルダを選ぶと、ここに並びます。元のファイルは動かさず、書き換えません。";
/** 選んだフォルダに写真が無い（絞り込みの条件が無い）とき。 */
export const PHOTO_EDITING_FOLDER_EMPTY_TEXT = "このフォルダに写真はありません";
/** フォルダの名前が分からないとき（木を読み直している間など）のパンくずの段。 */
export const PHOTO_EDITING_FOLDER_FALLBACK_LABEL = "フォルダ";
/** 根のフォルダの「⋯」の項目と、その確かめ。 */
export const PHOTO_EDITING_FORGET_FOLDER_LABEL = "一覧から外す";
export const PHOTO_EDITING_FORGET_FOLDER_TITLE = "フォルダを一覧から外しますか？";
export const PHOTO_EDITING_FORGET_FOLDER_CONFIRM_LABEL = "外す";
export function photoEditingForgetFolderDescription(name: string): string {
  return `「${name}」を一覧から外します。フォルダと写真は消えません。`;
}
/** 根のフォルダの「⋯」の読み上げ名。 */
export function photoEditingFolderMenuLabel(name: string): string {
  return `${name} のメニュー`;
}
/** 子のあるフォルダの開閉の読み上げ名。 */
export function photoEditingFolderToggleLabel(name: string, expanded: boolean): string {
  return expanded ? `${name} を閉じる` : `${name} を開く`;
}
/** 状態欄・一覧の 1 行（失敗）。 */
export const PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT = "フォルダを読み込めませんでした。";
export const PHOTO_EDITING_ADD_FOLDER_FAILED_TEXT = "フォルダを追加できませんでした。";
export const PHOTO_EDITING_FORGET_FOLDER_FAILED_TEXT = "一覧から外せませんでした。";
export const PHOTO_EDITING_ADD_SELECTED_PHOTOS_FAILED_TEXT = "写真を追加できませんでした。もう一度お試しください。";
export const PHOTO_EDITING_FORGET_SELECTED_PHOTOS_LABEL = "一覧から外す";
export const PHOTO_EDITING_FORGET_SELECTED_PHOTOS_TITLE = "選んだ写真を一覧から外しますか？";
export const PHOTO_EDITING_FORGET_SELECTED_PHOTOS_DESCRIPTION =
  "選んだ写真を一覧から外します。元の写真、フォルダ、保存した補正は消えません。";
export const PHOTO_EDITING_FORGET_SELECTED_PHOTOS_FAILED_TEXT = "選んだ写真を一覧から外せませんでした。";
/** この Mac の写真の一覧を読めなかった（クラウドの「クラウドの写真を読み込めませんでした。」の代わり）。 */
export const PHOTO_EDITING_LOCAL_PHOTOS_LOAD_FAILED_TEXT = "写真を読み込めませんでした。";
