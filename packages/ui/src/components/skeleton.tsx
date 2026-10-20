import { cn } from "../cn";

/**
 * ローディング中のプレースホルダー1枚分。既定の見た目
 * （角丸 + niho-border 背景 + pulse）は className で上書き・追加できる。
 */
export function Skeleton(props: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-niho-border", props.className)} />;
}

/**
 * Skeleton を count 枚並べる。並べ方（space-y など）は呼び出し側の
 * 親要素が持つため、このコンポーネント自体はレイアウトを持たない。
 */
export function SkeletonList(props: { count: number; className?: string }) {
  const { count, className } = props;
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className={className} />
      ))}
    </>
  );
}
