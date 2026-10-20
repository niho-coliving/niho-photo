// niho/no-fragile-text-px
//
// root font-size=106.25%（≒17px・全幅）昇格後、Tailwind の任意px `text-[Npx]` は
// root にも rem にも追従せず literally N px に固定される（階層逆転の温床）。
// 情報・見出し帯に相当する 11〜18px の固定px を禁止し、トークン
// (text-xs/text-sub/text-sm/text-body/text-base/text-lg) を使わせる。
// 残置帯（8〜10px）と天井帯（19px+）は例外として許容する。
//
// 11〜18px は小数（例: text-[14.25px] / text-[18.75px]）も含めて禁止する。
// 19px 以上（text-[19px] / text-[20px]）と 10px 以下、`text-` 以外の任意px
// （leading-[16px] 等）はマッチしない。
export const FRAGILE_TEXT_PX_REGEX = /\btext-\[1[1-8](?:\.\d+)?px\]/;

export const noFragileTextPxMessage =
  "固定px `text-[Npx]`(11〜18px) は root に追従しません。トークン(text-xs/sub/sm/body/base/lg)を使ってください（残置帯8〜10px・天井帯19px+のみ例外）。";

export const noFragileTextPxRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow fragile fixed px text classes in the root-following typography band",
    },
    schema: [],
  },
  create(context) {
    const filename = (context.filename ?? "").replaceAll("\\", "/");

    // このルール自身の定義・テスト（境界条件として固定px文字列を含む）と、
    // PDF系の独立タイポグラフィ（receipt-document-view）は対象外。
    if (filename.includes("/eslint-rules/") || filename.endsWith("receipt-document-view.tsx")) {
      return {};
    }

    const reportIfFragileTextPx = (node, value) => {
      if (typeof value === "string" && FRAGILE_TEXT_PX_REGEX.test(value)) {
        context.report({ node, message: noFragileTextPxMessage });
      }
    };

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          reportIfFragileTextPx(node, node.value);
        }
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          reportIfFragileTextPx(node, quasi.value.cooked ?? quasi.value.raw);
        }
      },
    };
  },
};
