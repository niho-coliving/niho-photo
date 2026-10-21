import { describe, expect, it } from "vitest";

import { PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS } from "./photo-editing-copy";
import {
  describeUnsupportedPresetItems,
  presetUsesLightroomColorTable,
  summarizeUnsupportedPresetItems,
} from "./photo-preset-xmp-support";

function xmp(attributes: string, body = ""): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ${attributes}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
}

describe("summarizeUnsupportedPresetItems", () => {
  it("crate の UNSUPPORTED_KNOWN を Lightroom の日本語の名前にまとめる（同じ名前は 1 つ・表の順）", () => {
    expect(
      summarizeUnsupportedPresetItems([
        "IncrementalTemperature",
        "IncrementalTint",
        "AutoLateralCA",
        "LensProfileEnable",
        "LensProfileSetup",
      ]),
    ).toEqual({ labels: ["色収差の除去", "レンズ補正", "色温度・色かぶり補正"], otherCount: 0 });
  });

  it("シャープ・ノイズ軽減は描けるので、届くのは読めない値と既定でない細かな項目だけ（Issue #32）", () => {
    // crate 0.19.0 はシャープ・ノイズ軽減・カラーノイズの軽減を approximate で返す。unsupported に来るのは、読めない値（主の項目）と、
    // 既定（ディテール 50・コントラスト 0・滑らかさ 50）でない細かな項目
    const text = xmp(
      [
        'crs:Sharpness="sharp"',
        'crs:LuminanceSmoothing="30"',
        'crs:LuminanceNoiseReductionContrast="20"',
        'crs:ColorNoiseReduction="25"',
        'crs:ColorNoiseReductionSmoothness="70"',
      ].join(" "),
    );
    expect(
      summarizeUnsupportedPresetItems(
        ["Sharpness", "LuminanceNoiseReductionContrast", "ColorNoiseReductionSmoothness"],
        text,
      ),
    ).toEqual({
      labels: ["シャープ", "ノイズ軽減のディテール・コントラスト", "カラーノイズの軽減のディテール・滑らかさ"],
      otherCount: 0,
    });
    // ノイズ軽減が 0 なら細かな項目は効かないので知らせない
    expect(
      summarizeUnsupportedPresetItems(
        ["LuminanceNoiseReductionContrast"],
        xmp('crs:LuminanceSmoothing="0" crs:LuminanceNoiseReductionContrast="20"'),
      ),
    ).toEqual({ labels: [], otherCount: 0 });
  });

  it("まだ描けない効果（白黒・周辺光量補正・粒子）も Lightroom の名前にする", () => {
    expect(
      summarizeUnsupportedPresetItems([
        "ConvertToGrayscale",
        "GrayMixerRed",
        "PostCropVignetteAmount",
        "PostCropVignetteMidpoint",
        "GrainAmount",
        "GrainSize",
        "CurveRefineSaturation",
      ]).labels,
    ).toEqual(["白黒", "周辺光量補正", "粒子", "トーンカーブの彩度"]);
  });

  it("カラーグレーディングの中間調・全体の輝度は描ける（エンジン 0.19.0〜。niho-photo#39）ので、知らせの名前を持たない", () => {
    expect(Object.values(PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS)).not.toContain("カラーグレーディングの輝度");
    expect(Object.keys(PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS)).not.toContain("colorGradeLuminance");
  });

  it("変形の手動のスライダーは描ける（エンジン 0.20.0〜。niho-photo#46）ので、残るのは Upright がオンのときの自動計算だけ", () => {
    expect(Object.keys(PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS)).not.toContain("transform");
    const on = xmp('crs:PerspectiveUpright="1" crs:PerspectiveVertical="-20" crs:UprightTransform_0="1 0 0 0 1 0 0 0 1"');
    expect(summarizeUnsupportedPresetItems(["PerspectiveUpright", "UprightTransform_0"], on)).toEqual({
      labels: [PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS.upright],
      otherCount: 0,
    });
    // Upright がオフなら知らせない（crate は計算値を `unsupported` に入れないが、入っていても外す）
    const off = xmp('crs:PerspectiveUpright="0" crs:UprightTransform_0="1 0 0 0 1 0 0 0 1"');
    expect(summarizeUnsupportedPresetItems(["PerspectiveUpright", "UprightTransform_0"], off)).toEqual({ labels: [], otherCount: 0 });
    expect(describeUnsupportedPresetItems(["PerspectiveUpright"], on)).toContain("Upright の自動計算");
  });

  it("表に無い項目は数だけ数える（同じ項目は 1 回）。埋め込みの Look は数えない", () => {
    expect(summarizeUnsupportedPresetItems(["FutureThing", "FutureThing", "AnotherThing", "Look.Name", "Look.Amount"])).toEqual({
      labels: [],
      otherCount: 2,
    });
  });

  it("XMP を渡すと、値が 0 / False の項目（主の項目が 0 の群）を外す", () => {
    const text = xmp(
      [
        'crs:Sharpness="0"',
        'crs:SharpenRadius="+1.0"',
        'crs:SharpenDetail="25"',
        'crs:LuminanceSmoothing="20"',
        'crs:ColorNoiseReduction="0"',
        'crs:ColorNoiseReductionDetail="50"',
        'crs:AutoLateralCA="0"',
        'crs:LensProfileEnable="0"',
        'crs:LensProfileSetup="LensDefaults"',
        'crs:IncrementalTemperature="0"',
        'crs:IncrementalTint="+5"',
        'crs:ConvertToGrayscale="False"',
        'crs:GrainAmount="0"',
        'crs:GrainSize="25"',
        'crs:CropConstrainToWarp="0"',
        'crs:OverrideLookVignette="False"',
        'crs:PerspectiveUpright="0"',
        'crs:PerspectiveScale="100"',
        'crs:CameraProfile="Default Color"',
        'crs:FutureThing="3"',
      ].join(" "),
    );
    expect(
      summarizeUnsupportedPresetItems(
        [
          "Sharpness",
          "SharpenRadius",
          "SharpenDetail",
          "LuminanceSmoothing",
          "ColorNoiseReduction",
          "ColorNoiseReductionDetail",
          "AutoLateralCA",
          "LensProfileEnable",
          "LensProfileSetup",
          "IncrementalTemperature",
          "IncrementalTint",
          "ConvertToGrayscale",
          "GrainAmount",
          "GrainSize",
          "CropConstrainToWarp",
          "OverrideLookVignette",
          "PerspectiveUpright",
          "CameraProfile",
          "FutureThing",
        ],
        text,
      ),
    ).toEqual({ labels: ["ノイズ軽減", "色温度・色かぶり補正"], otherCount: 1 });
    // 細かな項目は主の項目（ノイズ軽減 20）が効いていれば、細かな項目の名前で知らせる
    expect(summarizeUnsupportedPresetItems(["LuminanceNoiseReductionDetail"], text).labels).toEqual([
      "ノイズ軽減のディテール・コントラスト",
    ]);
  });

  it("主の項目が XMP に無い群と、値を読めなかった項目は外さない。既定でないプロファイルは知らせる", () => {
    const text = xmp('crs:SharpenRadius="+1.4" crs:CameraProfile="Camera Vivid"', "<crs:GrainAmount>30</crs:GrainAmount>");
    expect(summarizeUnsupportedPresetItems(["SharpenRadius", "GrainAmount", "CameraProfile", "Unreadable"], text)).toEqual({
      labels: ["シャープ", "粒子", "プロファイル"],
      otherCount: 1,
    });
  });

  it("埋め込みの Look の中の値は、根の値として読まない", () => {
    const text = xmp(
      'crs:Sharpness="40"',
      '<crs:Look><rdf:Description crs:Name="Adobe Color" crs:Sharpness="0" crs:Stubbed="true"/></crs:Look>',
    );
    expect(summarizeUnsupportedPresetItems(["Sharpness", "Look.Name", "Look.Stubbed"], text).labels).toEqual(["シャープ"]);
  });
});

describe("describeUnsupportedPresetItems", () => {
  it("名前を「・」でつなぎ、表に無い項目は「ほか N 項目」", () => {
    expect(describeUnsupportedPresetItems(["Sharpness", "LuminanceSmoothing"])).toBe(
      "シャープ・ノイズ軽減は使えないので、それ以外を取り込みました",
    );
    expect(describeUnsupportedPresetItems(["Sharpness", "FutureThing", "AnotherThing"])).toBe(
      "シャープ・ほか 2 項目は使えないので、それ以外を取り込みました",
    );
    expect(describeUnsupportedPresetItems(["FutureThing"])).toBe("1 項目は使えないので、それ以外を取り込みました");
    expect(describeUnsupportedPresetItems(["PointColors"])).toBe(
      "Lightroom のポイントカラーは使えないので、それ以外を取り込みました",
    );
  });

  it("知らせる項目が無ければ null", () => {
    expect(describeUnsupportedPresetItems([])).toBeNull();
    expect(describeUnsupportedPresetItems(["Look.Name"])).toBeNull();
    expect(describeUnsupportedPresetItems(["Sharpness"], xmp('crs:Sharpness="0"'))).toBeNull();
  });

  it("読めなかったマスク（crate の `<一覧>.<n>.<理由>`）を種類ごとの名前にする（読んだマスクは知らせない）", () => {
    const corrections = '<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li crs:What="Correction"/></rdf:Seq></crs:MaskGroupBasedCorrections>';
    expect(
      describeUnsupportedPresetItems(
        [
          "MaskGroupBasedCorrections.4.rotatedRadial",
          "MaskGroupBasedCorrections.4.radialRoundness",
          "MaskGroupBasedCorrections.2.brush",
          "PaintBasedCorrections.1.brush",
          "MaskGroupBasedCorrections.3.aiMask",
        ],
        xmp('crs:Exposure2012="+0.1"', corrections),
      ),
    ).toBe("ブラシのマスク・AI のマスク（被写体や空など）・一部の円形グラデーション（回転など）は使えないので、それ以外を取り込みました");
    expect(
      summarizeUnsupportedPresetItems([
        "MaskGroupBasedCorrections.1.rangeMask",
        "MaskGroupBasedCorrections.1.multipleMasks",
        "MaskGroupBasedCorrections.2.maskBlend",
        "MaskGroupBasedCorrections.3.maskValue",
        "MaskGroupBasedCorrections.9.tooMany",
        "MaskGroupBasedCorrections.1.LocalHue",
        "MaskGroupBasedCorrections.1.LocalToningSaturation",
        "MaskGroupBasedCorrections.1.LocalSharpness",
        "MaskGroupBasedCorrections.1.LocalMoire",
        "MaskGroupBasedCorrections.1.LocalExposure",
        "MaskGroupBasedCorrections.1.LocalTemperature",
        "MaskGroupBasedCorrections.5.outOfRange",
        "MaskGroupBasedCorrections.6.unknownMask",
        "MaskGroupBasedCorrections",
        "MaskGroupBasedCorrections.1.LocalFutureSlider",
        "MaskGroupBasedCorrections.2.radialFlipped",
        // 旧形式の一覧は読まず、補正ごとに知らせる
        "GradientBasedCorrections.1.legacyList",
        "CircularGradientBasedCorrections.2.legacyList",
      ]),
    ).toEqual({
      labels: [
        "範囲マスク",
        "一部の円形グラデーション（回転など）",
        "重ねたマスク",
        "マスクの不透明度",
        "9 枚目からのマスク",
        "マスクの色相とカラー",
        "マスクのシャープとノイズ軽減",
        "マスクの旧式の補正",
        "マスクの色温度と色かぶり",
        "旧形式のマスク",
        "読めないマスク",
      ],
      // 名前の無い局所補正は数だけ
      otherCount: 1,
    });
  });

  it("局所補正の一覧の中の値（マスクごとの Version など）は根の値として読まない", () => {
    const text = xmp(
      'crs:Sharpness="0" crs:Version="17.0"',
      '<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction" crs:Sharpness="25"/></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>',
    );
    expect(describeUnsupportedPresetItems(["Sharpness"], text)).toBeNull();
  });
});

describe("presetUsesLightroomColorTable", () => {
  it("色の表を使わないプリセット（Adobe Color の Look・RequiresRGBTables=False）は false", () => {
    expect(presetUsesLightroomColorTable(xmp('crs:Exposure2012="+0.40" crs:RequiresRGBTables="False"'))).toBe(false);
    expect(
      presetUsesLightroomColorTable(
        xmp(
          'crs:Exposure2012="+0.40"',
          '<crs:Look><rdf:Description crs:Name="Adobe Color" crs:Amount="1" crs:Stubbed="true"><crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Profiles</rdf:li></rdf:Alt></crs:Group></rdf:Description></crs:Look>',
        ),
      ),
    ).toBe(false);
  });

  it("古い Lightroom が Adobe Color の Look に書く LookTable の参照だけなら false", () => {
    expect(
      presetUsesLightroomColorTable(
        xmp(
          'crs:Exposure2012="+0.40"',
          '<crs:Look><rdf:Description crs:Name="Adobe Color"><crs:Parameters><rdf:Description crs:LookTable="E1095149FDB39D7A057BAB208837E2E1"/></crs:Parameters></rdf:Description></crs:Look>',
        ),
      ),
    ).toBe(false);
  });

  it("根に RGB の表・Look の表・RequiresRGBTables=True があれば true", () => {
    expect(presetUsesLightroomColorTable(xmp('crs:RequiresRGBTables="True"'))).toBe(true);
    expect(presetUsesLightroomColorTable(xmp('crs:RGBTable="D133EC539BB44CE73B8890C50B8D9F9E"'))).toBe(true);
    expect(presetUsesLightroomColorTable(xmp('crs:LookTable="E1095149FDB39D7A057BAB208837E2E1"'))).toBe(true);
    expect(presetUsesLightroomColorTable(xmp('crs:Table_D133EC539BB44CE73B8890C50B8D9F9E="abc"'))).toBe(true);
    expect(presetUsesLightroomColorTable(xmp("", "<crs:RequiresRGBTables>True</crs:RequiresRGBTables>"))).toBe(true);
  });

  it("空の参照と、名前が似ているだけの項目（RGBTableAmount）は数えない", () => {
    expect(presetUsesLightroomColorTable(xmp('crs:RGBTable="" crs:RGBTableAmount="1"'))).toBe(false);
  });

  it("Adobe Color / Adobe Standard 以外のプロファイルの Look は、名前だけの参照でも true", () => {
    expect(
      presetUsesLightroomColorTable(
        xmp('crs:Exposure2012="0"', '<crs:Look><rdf:Description crs:Name="Artistic 01" crs:Stubbed="true"/></crs:Look>'),
      ),
    ).toBe(true);
    expect(
      presetUsesLightroomColorTable(
        xmp(
          "",
          '<crs:Look><rdf:Description><crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Modern 05</rdf:li></rdf:Alt></crs:Name></rdf:Description></crs:Look>',
        ),
      ),
    ).toBe(true);
  });

  it("Look の中に表の中身があれば、Adobe Color の名前でも true。名前の無い空の Look は false", () => {
    expect(
      presetUsesLightroomColorTable(
        xmp(
          "",
          '<crs:Look><rdf:Description crs:Name="Adobe Color"><crs:Parameters><rdf:Description crs:RGBTable="AA" crs:Table_AA="zzz"/></crs:Parameters></rdf:Description></crs:Look>',
        ),
      ),
    ).toBe(true);
    expect(presetUsesLightroomColorTable(xmp("", '<crs:Look><rdf:Description crs:Name=""/></crs:Look>'))).toBe(false);
  });
});
