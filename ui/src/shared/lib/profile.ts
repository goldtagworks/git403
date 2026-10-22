// 데모·E2E(VITE_MOCK)에서만 컴포넌트 렌더 횟수를 window.__renders에 센다.
// 무거운 컴포넌트 첫 줄에서 countRender("이름")을 부른다. 회귀는 e2e/render.spec.ts가 잡는다.
const renders: Record<string, number> = ((window as any).__renders ??= {});

export const countRender = import.meta.env.VITE_MOCK
  ? (id: string) => void (renders[id] = (renders[id] ?? 0) + 1)
  : () => {};
