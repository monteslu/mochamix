/**
 * Knob — a reusable rotary control bound to a control-bus value via drag. The
 * React analog of Mixxx's WKnob. Vertical drag changes the value; double-click
 * resets to center. Renders an SVG arc.
 */

import { useCallback, useRef } from 'react';
import { useControl } from '../dj-context.js';
import type { Group, Key } from '@internal-dj/control-bus';

interface Props {
  group: Group;
  ckey: Key;
  label: string;
  min: number;
  max: number;
  /** Value the knob resets to on double-click. */
  center: number;
}

const SWEEP = 270; // degrees of total travel
const START = -135; // degrees at min

export function Knob({ group, ckey, label, min, max, center }: Props): React.JSX.Element {
  const [value, setValue] = useControl(group, ckey);
  const dragState = useRef<{ y: number; v: number } | null>(null);

  const norm = (value - min) / (max - min);
  const angle = START + norm * SWEEP;

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
      if (!d) {
        return;
      }
      const dy = d.y - e.clientY; // up = increase
      const span = max - min;
      const next = Math.max(min, Math.min(max, d.v + (dy / 150) * span));
      setValue(next);
    },
    [min, max, setValue],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragState.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div className="knob" title={`${label}: ${value.toFixed(2)}`}>
      <svg
        viewBox="0 0 48 48"
        width={44}
        height={44}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setValue(center)}
        style={{ touchAction: 'none', cursor: 'ns-resize' }}
      >
        <circle cx={24} cy={24} r={18} className="knob-body" />
        <line
          x1={24}
          y1={24}
          x2={24 + 14 * Math.cos((angle - 90) * (Math.PI / 180))}
          y2={24 + 14 * Math.sin((angle - 90) * (Math.PI / 180))}
          className="knob-indicator"
        />
      </svg>
      <span className="knob-label">{label}</span>
    </div>
  );
}
