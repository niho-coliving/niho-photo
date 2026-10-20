/**
 * NIHO photo の Tailwind（v4。`src/styles.css` が `@config` で読む）。テーマ（色・書体・文字の大きさ・角丸・影・動き）は web と
 * 共有する packages/ui/tailwind-theme.cjs、テーマが読む CSS 変数は packages/ui/src/styles/tokens.css（web の globals.css の写し）。
 *
 * content を明示すると自動のソース検出に頼れないので、class 文字列を持つ所を全部挙げる。共有の編集面（packages/photo-editing）と
 * 部品（packages/ui）は apps/camera の外。テーマのファイル自身も入れる（設定の文字列から `.font-sans` などが作られる。web と同じ）。
 * @type {import("tailwindcss").Config}
 */
const config = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/photo-editing/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/tailwind-theme.cjs",
  ],
  theme: {
    extend: require("../../packages/ui/tailwind-theme.cjs").extend,
  },
  plugins: [require("tailwindcss-animate")],
};
module.exports = config;
