/**
 * Knob — a reusable rotary control bound to a control-bus value via drag. The
 * React analog of Mixxx's WKnob. Vertical drag changes the value; double-click
 * resets to center. Renders an SVG dial with a value arc.
 */

import { useCallback, useRef } from 'react';
import { useControl } from '../dj-context.js';
import type { Group, Key } from '@dj/control-bus';

interface Props {
  group: Group;
  ckey: Key;
  label: string;
  min: number;
  max: number;
  /** Value the knob resets to on double-click. */
  center: number;
  big?: boolean;
  /** Tooltip describing what the knob does (shown with the live value). */
  hint?: string;
}

const SWEEP = 270; // degrees of total travel
const START = -135; // degrees at min (top-left)

/** Polar → cartesian on the dial (0° = up, clockwise). */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

export function Knob({ group, ckey, label, min, max, center, big, hint }: Props): React.JSX.Element {
  const [value, setValue] = useControl(group, ckey);
  const dragState = useRef<{ y: number; v: number } | null>(null);

  // Map value→norm so the CENTER (default) value sits at 12 o'clock (norm 0.5):
  // below-center fills the lower half [0,0.5], above-center the upper half
  // [0.5,1]. This is what DJ EQ/gain knobs do — unity points straight up, not at
  // 25% of the raw range (which looked like ~10 o'clock). When center is at an end
  // (min or max), it degrades to a normal linear sweep.
  let norm: number;
  if (center > min && center < max) {
    norm =
      value <= center
        ? 0.5 * ((value - min) / (center - min))
        : 0.5 + 0.5 * ((value - center) / (max - center));
  } else {
    norm = (value - min) / (max - min);
  }
  norm = Math.max(0, Math.min(1, norm));
  const angle = START + norm * SWEEP;
  const size = big ? 60 : 44;
  const C = 24;
  const R = 18;

  // The value arc: for a center-anchored knob it fills FROM 12 o'clock (the
  // detent) to the current angle — so you see how far above/below unity you are.
  // For an end-anchored knob it fills from the min end.
  const centered = center > min && center < max;
  const arcFromAngle = centered ? 0 /* 12 o'clock */ : START;
  const [ax, ay] = polar(C, C, R, arcFromAngle);
  const [bx, by] = polar(C, C, R, angle);
  const sweepDeg = Math.abs(angle - arcFromAngle);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  const sweepFlag = angle >= arcFromAngle ? 1 : 0;
  const arc = `M ${ax} ${ay} A ${R} ${R} 0 ${largeArc} ${sweepFlag} ${bx} ${by}`;
  // full-sweep track (always the whole dial)
  const [sx, sy] = polar(C, C, R, START);
  const [tx, ty] = polar(C, C, R, START + SWEEP);
  const track = `M ${sx} ${sy} A ${R} ${R} 0 1 1 ${tx} ${ty}`;
  const [ix, iy] = polar(C, C, R - 4, angle);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture(e.pointerId);
      dragState.current = { y: e.clientY, v: value };
    },
    [value],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dy = d.y - e.clientY;
      const span = max - min;
      setValue(Math.max(min, Math.min(max, d.v + (dy / 150) * span)));
    },
    [min, max, setValue],
  );
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragState.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      className={`knob ${big ? 'knob-big' : ''}`}
      title={`${hint ? hint + ' — ' : ''}${label}: ${value.toFixed(2)} (drag to adjust, double-click to reset)`}
    >
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setValue(center)}
        style={{ touchAction: 'none', cursor: 'ns-resize' }}
      >
        <defs>
          <radialGradient id="knobgrad" cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#3a4458" />
            <stop offset="100%" stopColor="#1a2030" />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r={R + 2} className="knob-rim" />
        <circle cx={C} cy={C} r={R - 1} className="knob-body" />
        <path d={track} className="knob-track" fill="none" />
        <path d={arc} className="knob-arc" fill="none" />
        <line x1={C} y1={C} x2={ix} y2={iy} className="knob-indicator" />
      </svg>
      <span className="knob-label">{label}</span>
    </div>
  );
}
