/** 写真編集の値の型。ホストのAPI・デスクトップブリッジに依存しない。 */

/** Photo Bench の `EditSettings` の JSON。ページは調整項目のキーだけを書き換え、他のキーはそのまま返す。 */
export type PhotoEditingSettings = Record<string, unknown>;

export type PhotoEditingWhiteBalanceValue = {
  temperature: number;
  tint: number;
};

export type PhotoEditingPhotoKind = "raw" | "raster";

/**
 * RAW をどう現像したか。`adobe` は Adobe のカメラプロファイル（Lightroom と同じ基準の色）、
 * `fallback` はプロファイルが無い Mac で macOS の RAW 現像に落ちたもの（色が Lightroom と揃わない）。
 * RAW 以外と、`profile` を返さない古いエンジンは null。
 */
export type PhotoEditingProfile = "adobe" | "fallback";

export type PhotoEditingBuiltinPreset = {
  id: string;
  name: string;
  xmp: string;
};

/**
 * NIHO Desktop が開いた写真（bridge の `photo_editing_open_photos` などの結果。編集面は撮影時の白〔`asShotWhiteBalance`〕と
 * 何も当てていない状態〔`settings`〕を読む）。
 */
export type PhotoEditingPhoto = {
  photoId: string;
  kind: PhotoEditingPhotoKind;
  fileName: string;
  /** 向きを反映した原寸 */
  width: number;
  height: number;
  /** 撮影時の色温度・色かぶり。Adobe のプロファイルで開いた RAW だけ。null なら相対値で補正する */
  asShotWhiteBalance: PhotoEditingWhiteBalanceValue | null;
  /** 何も当てていない状態（Photo Bench の `EditSettings.neutral`）。「初期化」で戻す先 */
  settings: PhotoEditingSettings;
  /**
   * この Mac に保存した同じ写真（中身で見分ける）の設定。無ければ null。開いた写真は
   * `savedSettings ?? settings` から始める。v9 の NIHO Desktop は返さない（null）。
   */
  savedSettings: PhotoEditingSettings | null;
  profile: PhotoEditingProfile | null;
  /**
   * 写真の中身（ファイル全体）の SHA-256（16 進の小文字 64 文字、v11〜）。編集内容の保存のキーと同じで、
   * クラウドの写真置き場の `contentSha256`。v10 までの NIHO Desktop は返さない（null）
   */
  contentSha256: string | null;
  /** 写真のファイルの大きさ（バイト、v11〜）。v10 までは null */
  sizeBytes: number | null;
};
