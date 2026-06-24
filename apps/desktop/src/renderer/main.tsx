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
  console.error('[internal-dj] not cross-origin isolated — SharedArrayBuffer unavailable');
}
if (!('gpu' in navigator)) {
  console.error('[internal-dj] WebGPU unavailable — required, no fallback');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
