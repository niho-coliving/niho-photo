/**
 * JSX の `inert` に渡す値。
 *
 * react-dom 18 は `inert` を boolean 属性として認識せず、`true` を渡すと
 * 「Received `true` for a non-boolean attribute」の警告を出して属性を描画しない。
 * HTML の boolean 属性規約どおり、有効時は空文字列（`inert=""` が描画される）、
 * 無効時は `undefined`（属性を省略）を渡す。
 * `@types/react` の experimental 型は `inert?: boolean` なので、空文字列をその型へ寄せる。
 */
export function inertAttribute(inert: boolean): boolean | undefined {
  return inert ? ("" as unknown as boolean) : undefined;
}
