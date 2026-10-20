import { describe, expect, it } from "vitest";

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
        "Sharpness",
        "SharpenRadius",
        "SharpenDetail",
        "SharpenEdgeMasking",
        "LuminanceSmoothing",
        "ColorNoiseReduction",
        "ColorNoiseReductionDetail",
        "ColorNoiseReductionSmoothness",
        "AutoLateralCA",
        "LensProfileEnable",
        "LensProfileSetup",
      ]),
    ).toEqual({
      labels: ["シャープ", "ノイズ軽減", "カラーノイズの軽減", "色収差の除去", "レンズ補正", "色温度・色かぶり補正"],
      otherCount: 0,
    });
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
        "ColorGradeGlobalLum",
        "CurveRefineSaturation",
      ]).labels,
    ).toEqual(["白黒", "周辺光量補正", "粒子", "カラーグレーディングの輝度", "トーンカーブの彩度"]);
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
          "PerspectiveScale",
          "CameraProfile",
          "FutureThing",
        ],
        text,
      ),
    ).toEqual({ labels: ["ノイズ軽減", "色温度・色かぶり補正"], otherCount: 1 });
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
  });

  it("知らせる項目が無ければ null", () => {
    expect(describeUnsupportedPresetItems([])).toBeNull();
    expect(describeUnsupportedPresetItems(["Look.Name"])).toBeNull();
    expect(describeUnsupportedPresetItems(["Sharpness"], xmp('crs:Sharpness="0"'))).toBeNull();
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
