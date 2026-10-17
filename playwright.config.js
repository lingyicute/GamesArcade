const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 12000 },
  fullyParallel: true,
  // Canvas-heavy cross-browser tests can exhaust small CI/container machines.
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8000', contextOptions: { reducedMotion: 'reduce' } },
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName, use: { browserName }
  })),
  webServer: {
    command: 'python3 -m http.server 8000 --bind 0.0.0.0',
    url: 'http://127.0.0.1:8000',
    reuseExistingServer: !process.env.CI
  }
});
