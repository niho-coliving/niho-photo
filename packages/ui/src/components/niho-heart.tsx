"use client";

import { type CSSProperties, useEffect, useId, useRef, useState } from "react";

const GRADIENT_ID_LIKED = "niho-heart-warm-grad";

const STYLE_ID = "niho-heart-petal-css";
const PETAL_BASE = 24;

const ORGANIC = "cubic-bezier(0.22, 1, 0.36, 1)";

const PETAL_COLORS = ["#B3D97D", "#EDBA8E", "#8BC34A"] as const;
const PETAL_DURATIONS = ["0.7s", "0.65s", "0.75s"] as const;
const PETAL_DELAYS = ["0.02s", "0.08s", "0.12s"] as const;

function ensurePetalCSS() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
@keyframes niho-heart-pop{
  0%{transform:scale(1)}
  22%{transform:scale(1.22)}
  55%{transform:scale(0.96)}
  100%{transform:scale(1)}
}
@keyframes niho-petal-0{
  0%{transform:translate(-3px,-4px) rotate(0deg) scale(1);opacity:.85}
  60%{opacity:.6}
  100%{transform:translate(-12px,-28px) rotate(-40deg) scale(.3);opacity:0}
}
@keyframes niho-petal-1{
  0%{transform:translate(-3px,-4px) rotate(0deg) scale(1);opacity:.85}
  60%{opacity:.6}
  100%{transform:translate(10px,-26px) rotate(30deg) scale(.3);opacity:0}
}
@keyframes niho-petal-2{
  0%{transform:translate(-3px,-4px) rotate(0deg) scale(1);opacity:.8}
  60%{opacity:.5}
  100%{transform:translate(2px,-32px) rotate(15deg) scale(.2);opacity:0}
}`;
  document.head.appendChild(s);
}

/**
 * NIHOブランドのハートアイコン。
 *
 * ON状態: Warm Orange グラデーション (#EDBA8E → #D4874E) + ソフトハイライト
 * OFF状態: Muted Light ストローク (#C4C4BA)
 *
 * liked が false → true に遷移した瞬間、Petal Float アニメーションを自動再生。
 */
export function NihoHeart({
  liked,
  size = 18,
  className = "",
  style,
  ...rest
}: {
  liked: boolean;
  size?: number;
  className?: string;
  style?: CSSProperties;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "style">) {
  const prevLiked = useRef(liked);
  const [animating, setAnimating] = useState(false);
  const reactId = useId();
  const gradientId = `${GRADIENT_ID_LIKED}-${reactId.replace(/:/g, "")}`;

  useEffect(() => {
    ensurePetalCSS();
  }, []);

  useEffect(() => {
    if (liked && !prevLiked.current) {
      setAnimating(true);
      const id = setTimeout(() => setAnimating(false), 850);
      prevLiked.current = liked;
      return () => clearTimeout(id);
    }
    prevLiked.current = liked;
  }, [liked]);

  const scale = size / PETAL_BASE;

  return (
    <span
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        overflow: "visible",
        flexShrink: 0,
        ...style,
      }}
      {...rest}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={
          animating
            ? { animation: `niho-heart-pop 0.4s ${ORGANIC}` }
            : undefined
        }
      >
        {liked && (
          <defs>
            <linearGradient
              id={gradientId}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#EDBA8E" />
              <stop offset="100%" stopColor="#D4874E" />
            </linearGradient>
          </defs>
        )}
        <path
          d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
          fill={liked ? `url(#${gradientId})` : "none"}
          stroke={liked ? "none" : "#C4C4BA"}
          strokeWidth={liked ? 0 : 1.8}
        />
        {liked && (
          <ellipse
            cx="8.5"
            cy="8"
            rx="2"
            ry="1.5"
            fill="rgba(255,255,255,0.18)"
            transform="rotate(-25 8.5 8)"
          />
        )}
      </svg>

      {animating && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            overflow: "visible",
            transform: `scale(${scale})`,
            transformOrigin: "center",
          }}
        >
          {PETAL_COLORS.map((color, i) => (
            <svg
              key={i}
              width={6}
              height={8}
              viewBox="0 0 6 8"
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                marginTop: -4,
                marginLeft: -3,
                opacity: 0,
                animation: `niho-petal-${i} ${PETAL_DURATIONS[i]} ${ORGANIC} ${PETAL_DELAYS[i]} forwards`,
              }}
            >
              <ellipse
                cx="3"
                cy="4"
                rx="2.5"
                ry="3.5"
                fill={color}
                opacity={0.8}
              />
            </svg>
          ))}
        </span>
      )}
    </span>
  );
}
