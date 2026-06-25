import { defineConfig, devices } from '@playwright/test';

// E2E against the standalone browser build (vite.browser.config.ts). Playwright
// boots the dev server itself, so `npx playwright test` is one command. WebGL is
// the path under test (the waveform lanes), so we run real Chromium, not headless
// shell with swiftshader — the --use-angle flag keeps GL hardware-ish + reliable.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-angle=gl', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite --config vite.browser.config.ts --port 5174',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
