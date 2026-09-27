import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', timeout: 30_000, workers: 2,
  use: { baseURL: 'http://127.0.0.1:1438', headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 1438', url: 'http://127.0.0.1:1438', reuseExistingServer: false },
});
