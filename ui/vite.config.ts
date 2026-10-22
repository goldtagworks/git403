import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tauriConf from "../src-tauri/tauri.conf.json";

// Tauri dev 서버 규약: 고정 포트, 포트가 차 있으면 실패.
export default defineConfig({
  plugins: [react()],
  // 상태바 버전 표시: 앱 버전의 원본은 tauri.conf.json 하나
  define: { __APP_VERSION__: JSON.stringify(tauriConf.version) },
  // 상대 경로: VS Code 웹뷰(확장이 asWebviewUri로 치환)와 Tauri 둘 다 같은 빌드를 쓴다
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Tauri 웹뷰는 모두 최신 엔진이라 top-level await를 그대로 쓴다.
  build: { target: "es2022" },
});
