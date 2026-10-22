import { useEffect, useState } from "react";
import { IS_VSCODE, setWindowTheme } from "../api/bridge";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "theme";

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

/** VS Code 웹뷰: 호스트 테마는 body 클래스(vscode-light·vscode-dark·vscode-high-contrast[-light])로 온다 */
const vscodeDark = () => {
  const c = document.body.classList;
  return c.contains("vscode-dark") || (c.contains("vscode-high-contrast") && !c.contains("vscode-high-contrast-light"));
};

/**
 * 테마 모드 + 실제 적용된 테마("light" | "dark").
 * `resolved`가 바뀌면 Canvas처럼 CSS가 안 닿는 곳을 다시 그리면 된다.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(read);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(IS_VSCODE ? vscodeDark : media.matches);

  useEffect(() => {
    if (IS_VSCODE) {
      // "시스템" = VS Code 테마. body 클래스가 바뀔 때만 상태가 바뀐다
      const mo = new MutationObserver(() => setSystemDark(vscodeDark()));
      mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      return () => mo.disconnect();
    }
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") {
      if (!IS_VSCODE) root.removeAttribute("data-theme"); // VS Code의 시스템 모드는 아래 effect가 정한다
    } else root.setAttribute("data-theme", mode);
    // 창 반투명 효과(macOS)도 강제 테마를 따르게 한다
    if (root.classList.contains("vibrant")) setWindowTheme(mode === "system" ? null : mode).catch(() => {});
    try {
      localStorage.setItem(KEY, mode);
    } catch {}
  }, [mode]);

  // VS Code는 prefers-color-scheme이 호스트 테마와 다를 수 있어 시스템 모드도 data-theme으로 못박는다 (Tauri에서는 아무 일도 안 함)
  useEffect(() => {
    if (IS_VSCODE && mode === "system") document.documentElement.setAttribute("data-theme", systemDark ? "dark" : "light");
  }, [mode, systemDark]);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  return { mode, setMode, resolved } as const;
}

/** CSS 토큰 값을 읽는다. */
export const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

import type { Key } from "../i18n/i18n";

/** 강조색 선택지. "system"은 OS 강조색(AccentColor). 두 테마 모두에서 읽히는 중간 채도 값. */
/** [id, 이름의 문구 키(`t(label)`로 쓴다), 색] */
export const ACCENTS: [string, Key, string][] = [
  ["system", "theme.accent.system", ""],
  ["blue", "theme.accent.blue", "#3b6fd8"],
  ["purple", "theme.accent.purple", "#7a5bd0"],
  ["pink", "theme.accent.pink", "#c8507e"],
  ["red", "theme.accent.red", "#d0463f"],
  ["orange", "theme.accent.orange", "#d27a1f"],
  ["green", "theme.accent.green", "#2f9a5f"],
  ["graphite", "theme.accent.graphite", "#7b8090"],
];
const ACCENT_KEY = "accent";

export function readAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (ACCENTS.some(([id]) => id === v)) return v!;
  } catch {}
  return "system";
}

/** 강조색을 :root에 적용·저장한다. React 상태가 아니라서 바꿔도 리렌더링이 없다. */
export function applyAccent(id: string) {
  const color = ACCENTS.find(([a]) => a === id)?.[2];
  const s = document.documentElement.style;
  if (color) {
    s.setProperty("--accent", color);
    s.setProperty("--selected", `color-mix(in srgb, ${color} 18%, transparent)`);
  } else {
    s.removeProperty("--accent");
    s.removeProperty("--selected");
  }
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {}
}

applyAccent(readAccent());
