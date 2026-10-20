import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// カスタム fontSize トークン（tailwind.config.cjs の body/sub/fine）を font-size
// グループとして登録する。未登録だと twMerge が text-{color} と誤分類し、
// `cn("text-fine", "text-white")` のような合成でサイズクラスが除去される。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["body", "sub", "fine"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
