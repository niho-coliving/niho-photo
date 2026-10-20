"use client";

import { useId } from "react";
import { Pipette, RotateCcw, Trash2 } from "lucide-react";

import {
  developColorPoints,
  developSettingsVersion,
  type DevelopColorPoint,
  type DevelopSettings,
  MAX_COLOR_POINTS,
} from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";
import { cn } from "niho-ui/cn";

import { PhotoEditingSlider, type PhotoEditingSettingsUpdate, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

export type PickedOklch = { lightness: number; chroma: number; hue: number };
export type ColorPickSnapshot = { generation: number; photoKey: string; settingsJson: string };

export function colorPickIsCurrent(
  snapshot: ColorPickSnapshot,
  current: ColorPickSnapshot & { blocked: boolean },
): boolean {
  return !current.blocked && snapshot.generation === current.generation && snapshot.photoKey === current.photoKey && snapshot.settingsJson === current.settingsJson;
}

export async function commitColorPickIfCurrent(options: {
  sample: Promise<PickedOklch>;
  snapshot: ColorPickSnapshot;
  current: () => ColorPickSnapshot & { blocked: boolean };
  commit: (target: PickedOklch) => void;
}): Promise<boolean> {
  const target = await options.sample;
  if (!colorPickIsCurrent(options.snapshot, options.current())) return false;
  options.commit(target);
  return true;
}

export function canvasNormalizedPoint(
  canvas: Pick<HTMLCanvasElement, "getBoundingClientRect">,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const u = (clientX - rect.left) / rect.width;
  const v = (clientY - rect.top) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { x: u, y: v };
}

export function appendDevelopColorPoint(
  settings: DevelopSettings,
  target: PickedOklch,
  id = `color-${Date.now().toString(36)}`,
): DevelopSettings {
  const points = developColorPoints(settings);
  if (
    points.length >= MAX_COLOR_POINTS ||
    !Object.values(target).every(Number.isFinite) ||
    target.lightness < 0 || target.lightness > 1 || target.chroma < 0 || target.chroma > 5 || target.hue < 0 || target.hue >= 360
  ) return settings;
  const safeBase = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 56) || "color";
  let uniqueId = safeBase;
  for (let suffix = 2; points.some((point) => point.id === uniqueId); suffix += 1) {
    const ending = `-${suffix}`;
    uniqueId = `${safeBase.slice(0, 64 - ending.length)}${ending}`;
  }
  const point: DevelopColorPoint = {
    id: uniqueId,
    target: {
      lightness: target.lightness,
      chroma: target.chroma,
      hue: target.hue,
    },
    range: { hue: 30, chroma: 0.08, lightness: 0.15 },
    delta: { hue: 0, chromaScale: 1, lightness: 0 },
  };
  const next: DevelopSettings = { ...settings, colorPoints: [...points, point] };
  return { ...next, v: developSettingsVersion(next) };
}

function replacePoints(current: PhotoEditingSettings, points: DevelopColorPoint[]): PhotoEditingSettings {
  const next: Record<string, unknown> = { ...current };
  if (points.length === 0) delete next.colorPoints;
  else next.colorPoints = points;
  return { ...next, v: developSettingsVersion(next) } as PhotoEditingSettings;
}

type SliderSpec = {
  key: "range.hue" | "range.chroma" | "range.lightness" | "delta.hue" | "delta.chromaScale" | "delta.lightness";
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  read: (internal: number) => number;
  write: (display: number) => number;
  text: (display: number) => string;
};

const identity = (value: number) => value;
const degrees = (value: number) => `${Math.round(value)}°`;
const percent = (value: number) => `${Math.round(value)}%`;
const rangeChromaToDisplay = (value: number) => Math.max(0, Math.min(100, ((value - 0.001) / 0.499) * 100));
const rangeChromaFromDisplay = (value: number) => 0.001 + (value / 100) * 0.499;

const SLIDERS: readonly SliderSpec[] = [
  { key: "range.hue", label: "色相の範囲", min: 1, max: 180, step: 1, initial: 30, read: identity, write: identity, text: degrees },
  { key: "range.chroma", label: "彩度の範囲", min: 0, max: 100, step: 1, initial: rangeChromaToDisplay(0.08), read: rangeChromaToDisplay, write: rangeChromaFromDisplay, text: percent },
  { key: "range.lightness", label: "明るさの範囲", min: 0.1, max: 100, step: 0.1, initial: 15, read: (v) => v * 100, write: (v) => v / 100, text: percent },
  { key: "delta.hue", label: "色相", min: -180, max: 180, step: 1, initial: 0, read: identity, write: identity, text: degrees },
  { key: "delta.chromaScale", label: "彩度", min: -100, max: 200, step: 1, initial: 0, read: (v) => (v - 1) * 100, write: (v) => 1 + v / 100, text: percent },
  { key: "delta.lightness", label: "明るさ", min: -100, max: 100, step: 1, initial: 0, read: (v) => v * 100, write: (v) => v / 100, text: percent },
];

function pointValue(point: DevelopColorPoint, key: SliderSpec["key"]): number {
  const [group, field] = key.split(".") as ["range" | "delta", string];
  return (point[group] as Record<string, number>)[field] ?? 0;
}

function updatePoint(point: DevelopColorPoint, key: SliderSpec["key"], value: number): DevelopColorPoint {
  const [group, field] = key.split(".") as ["range" | "delta", string];
  return { ...point, [group]: { ...point[group], [field]: value } };
}

export function PhotoEditingColorMixer(props: {
  settings: DevelopSettings;
  disabled: boolean;
  picking: boolean;
  pickError: string | null;
  compact?: boolean;
  onPickStart: () => void;
  onPickCancel: () => void;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
}) {
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-color-mixer-title`;
  const points = developColorPoints(props.settings);
  const update = (id: string, key: SliderSpec["key"], value: number, phase: PhotoEditingSliderPhase) => {
    props.onSettingsChange(
      (current) => replacePoints(current, developColorPoints(current).map((point) => point.id === id ? updatePoint(point, key, value) : point)),
      phase,
    );
  };
  return (
    <section aria-labelledby={titleId} className={cn("pt-2", props.compact && "px-3 pb-2")}>
      <div className="flex min-h-11 items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 id={titleId} className="text-xs font-bold text-niho-text">色ミキサー</h4>
          <p className="text-xs leading-relaxed text-niho-text-muted">写真から色を選び、その色だけを自然に整えます。</p>
        </div>
        <button
          type="button"
          aria-pressed={props.picking}
          disabled={props.disabled || (!props.picking && points.length >= MAX_COLOR_POINTS)}
          onClick={props.picking ? props.onPickCancel : props.onPickStart}
          className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-bold text-niho-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-40"
        >
          <Pipette className="h-4 w-4" aria-hidden />
          {props.picking ? "キャンセル" : "色を拾う"}
        </button>
      </div>
      {props.picking ? <p role="status" className="pb-2 text-xs font-bold text-niho-accent-ink">写真上の印を矢印キーで動かせます。Enter または Space で決定、Esc でキャンセルします。</p> : null}
      {props.pickError ? <p role="alert" className="pb-2 text-xs font-bold text-niho-danger">{props.pickError}</p> : null}
      <div className="space-y-2">
        {points.map((point, index) => (
          <article key={point.id} className="rounded-xl border border-niho-border p-2">
            <div className="flex min-h-6 items-center gap-2">
              <span
                aria-hidden
                className="h-5 w-5 shrink-0 rounded-full border border-niho-border"
                style={{ backgroundColor: `oklch(${point.target.lightness} ${point.target.chroma} ${point.target.hue})` }}
              />
              <h5 className="min-w-0 flex-1 text-xs font-bold text-niho-text-sub">色 {index + 1}</h5>
              <button
                type="button"
                aria-label={`色 ${index + 1} を初期化`}
                disabled={props.disabled}
                onClick={() => {
                  props.onSettingsChange(
                    (current) => replacePoints(current, developColorPoints(current).map((candidate) => candidate.id === point.id
                      ? { ...candidate, delta: { hue: 0, chromaScale: 1, lightness: 0 } }
                      : candidate)),
                    "commit",
                  );
                }}
                className="flex h-6 w-6 items-center justify-center rounded-full text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`色 ${index + 1} を削除`}
                disabled={props.disabled}
                onClick={() => props.onSettingsChange(
                  (current) => replacePoints(current, developColorPoints(current).filter((candidate) => candidate.id !== point.id)),
                  "commit",
                )}
                className="flex h-6 w-6 items-center justify-center rounded-full text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1 min-[360px]:grid-cols-2 lg:grid-cols-1">
              {SLIDERS.map((slider) => {
                const value = slider.read(pointValue(point, slider.key));
                return (
                  <PhotoEditingSlider
                    key={slider.key}
                    id={`${idPrefix}-color-point-${index}-${slider.key.replace(".", "-")}`}
                    label={slider.label}
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    value={value}
                    valueText={slider.text(value)}
                    disabled={props.disabled}
                    onChange={(next, phase) => update(point.id, slider.key, slider.write(next), phase)}
                    onReset={() => update(point.id, slider.key, slider.write(slider.initial), "commit")}
                  />
                );
              })}
            </div>
          </article>
        ))}
      </div>
      <p className="pt-1 text-right text-xs tabular-nums text-niho-text-muted">{points.length}/{MAX_COLOR_POINTS}</p>
    </section>
  );
}
