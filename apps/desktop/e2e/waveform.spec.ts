import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';

// The bug this catches: the top scrolling waveform lanes render BLACK because the
// WebGL/GLSL shader fails to compile (a reserved word / a vec-vs-float name
// collision both silently set ok=false). A real-browser element screenshot is the
// reliable readback — reading the WebGL drawing buffer directly returns a cleared
// buffer post-composite (false black), so we screenshot the element instead.

function distinctColors(png: PNG): number {
  const colors = new Set<string>();
  const y = (png.height / 2) | 0;
  for (let x = 0; x < png.width; x += 8) {
    const i = (png.width * y + x) << 2;
    colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
  }
  return colors.size;
}

test('top waveform lanes render via WebGL (not blank)', async ({ page }) => {
  const glErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /shader|webgl|reserved|program|WaveformGL/i.test(m.text())) {
      glErrors.push(m.text());
    }
  });

  await page.goto('/browser.html?demo&gl');
  await page.waitForSelector('.wf-scroll', { timeout: 10_000 });
  await page.waitForTimeout(2500); // demo seeds at ~100ms; let peaks upload + draw

  const lanes = await page.locator('.wf-scroll').all();
  expect(lanes.length).toBeGreaterThanOrEqual(2);

  for (const [i, lane] of lanes.entries()) {
    const buf = await lane.screenshot();
    const png = PNG.sync.read(buf);
    // a drawing lane has many colors (bars + grid + playhead); a blank one has ~1
    expect(distinctColors(png), `lane ${i} renders waveform content`).toBeGreaterThan(3);
  }

  expect(glErrors, `shader/WebGL errors: ${glErrors.join(' | ')}`).toHaveLength(0);
});
