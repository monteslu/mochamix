import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('no #root element');
}

// Boot guard: we require cross-origin isolation (SAB) and WebGPU (no fallback —
// 10-electron-feasibility.md §0a). Fail loud rather than degrade.
if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
  console.error('[MochaMix] not cross-origin isolated: SharedArrayBuffer unavailable');
}
if (!('gpu' in navigator)) {
  console.error('[MochaMix] WebGPU unavailable: required, no fallback');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// Startup timing: most of the launch delay is the module bundle fetch+compile BEFORE this
// file runs (the inline boot spinner in index.html covers that window). Log first frame so
// regressions are visible.
requestAnimationFrame(() => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const sinceNav = nav ? performance.now() - nav.startTime : performance.now();
  console.log(`[perf] first frame at ${sinceNav.toFixed(0)}ms since navigation start`);
});
