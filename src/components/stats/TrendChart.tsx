"use client";

import { useState } from "react";
import type { Day } from "@/lib/report";

// Two panels on one shared day axis instead of one dual-axis chart: sends are ~100x replies, so
// they'd flatten each other. Hovering either panel shows that day's figures for both.
const BLUE = "#2a78d6"; // categorical slot 1: interested replies / emails sent
const ORANGE = "#eb6834"; // categorical slot 2: other replies

const W = 480;
const PAD_L = 30;
const PAD_R = 8;

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= v) ?? pow * 10;
  return step * 4;
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Panel({
  title,
  days,
  height,
  series,
  hover,
  setHover,
}: {
  title: string;
  days: Day[];
  height: number;
  series: { key: "sent" | "positive" | "other"; label: string; color: string }[];
  hover: number | null;
  setHover: (i: number | null) => void;
}) {
  const val = (d: Day, k: string) => (k === "other" ? Math.max(0, d.replied - d.positive) : (d[k as "sent" | "positive"] ?? 0));
  const total = (d: Day) => series.reduce((a, s) => a + val(d, s.key), 0);
  const max = niceMax(Math.max(0, ...days.map(total)));
  const plotH = height - 22;
  const step = (W - PAD_L - PAD_R) / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(18, step - 2)); // 2px gap between neighbouring bars
  const y = (v: number) => plotH - (v / max) * (plotH - 6);
  const ticks = [0, max / 2, max];
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((((e.clientX - box.left) / box.width) * W - PAD_L) / step);
    setHover(i >= 0 && i < days.length ? i : null);
  };
  const labelEvery = Math.ceil(days.length / 5);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-ink">{title}</span>
        {series.length > 1 && (
          <span className="flex gap-3 text-xs text-muted">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        role="img"
        aria-label={title}
        // Pointer events cover a mouse, a pen and a finger: tapping a day shows its figures, as hovering does.
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
        onPointerMove={(e) => pick(e)}
        onPointerDown={(e) => pick(e)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 3} textAnchor="end" className="fill-muted" fontSize={12}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {hover !== null && <rect x={PAD_L + hover * step} y={0} width={step} height={plotH} fill="var(--ink)" opacity={0.05} />}
        {days.map((d, i) => {
          let base = 0;
          const x = PAD_L + i * step + (step - barW) / 2;
          return (
            <g key={d.date}>
              {series.map((s, si) => {
                const v = val(d, s.key);
                if (!v) return null;
                const top = y(base + v);
                const h = y(base) - top - (si > 0 ? 2 : 0); // 2px surface gap between stacked segments
                base += v;
                const isTop = series.slice(si + 1).every((n) => !val(d, n.key));
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={top}
                    width={barW}
                    height={Math.max(1, h)}
                    rx={isTop ? Math.min(3, barW / 2) : 0}
                    fill={s.color}
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="fill-muted" fontSize={12}>
                  {fmtDay(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function TrendChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const d = hover !== null ? days[hover] : null;
  return (
    <div className="relative flex flex-col gap-3">
      <div className="h-5 text-xs text-muted print:hidden">
        {d ? (
          <span>
            <span className="font-medium text-ink">{fmtDay(d.date)}</span> · <span className="num text-ink">{d.sent}</span> sent ·{" "}
            <span className="num text-ink">{d.replied}</span> replies, of which <span className="num text-ink">{d.positive}</span> interested
          </span>
        ) : (
          "Point at or tap a day to see its figures"
        )}
      </div>
      <Panel title="Emails sent per day" days={days} height={120} series={[{ key: "sent", label: "Sent", color: BLUE }]} hover={hover} setHover={setHover} />
      {days.some((x) => x.replied > 0) ? (
      <Panel
        title="Replies per day"
        days={days}
        height={100}
        series={[
          { key: "positive", label: "Interested", color: BLUE },
          { key: "other", label: "Other replies", color: ORANGE },
        ]}
        hover={hover}
        setHover={setHover}
      />
      ) : (
        <p className="text-xs text-muted">No replies in this period yet.</p>
      )}
      <details className="text-xs print:hidden">
        <summary className="cursor-pointer text-muted">Show as a table</summary>
        <table className="mt-2 w-full">
          <thead className="text-left text-muted">
            <tr><th className="py-1 font-medium">Day</th><th className="font-medium">Sent</th><th className="font-medium">Replies</th><th className="font-medium">Interested</th></tr>
          </thead>
          <tbody>
            {days.filter((x) => x.sent || x.replied).map((x) => (
              <tr key={x.date} className="border-t border-line"><td className="py-1">{fmtDay(x.date)}</td><td className="num">{x.sent}</td><td className="num">{x.replied}</td><td className="num">{x.positive}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
