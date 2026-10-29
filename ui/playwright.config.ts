import { defineConfig } from "@playwright/test";

// UI E2E: Tauri IPC를 src/mock.ts로 대체한 브라우저에서 화면 흐름을 검증한다.
// 실제 git 동작은 crates/core/tests가 검증한다.
export default defineConfig({
  // E2E 관련 파일은 모두 e2e/ 아래: *.spec.ts(브라우저), app/(실제 앱), results/(결과·스크린샷, git 제외)
  testDir: "e2e",
  outputDir: "e2e/results/artifacts",
  globalSetup: "./e2e/setup.ts",
  use: { baseURL: "http://localhost:1421", locale: "ko-KR" },
  projects: [
    { name: "light", use: { colorScheme: "light" } },
    { name: "dark", use: { colorScheme: "dark" } },
  ],
  webServer: {
    command: "vite --port 1421 --strictPort",
    env: { VITE_MOCK: "1" },
    url: "http://localhost:1421",
    reuseExistingServer: !process.env.CI,
  },
});
