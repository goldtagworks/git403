import { useState } from "react";

/**
 * 크기를 저장하는 분할 패널 크기. `[size, splitter]`를 돌려준다.
 * splitter는 크기를 바꿀 패널 **바로 뒤**에 둔다.
 * 드래그 중에는 React 상태를 바꾸지 않고 앞 패널의 style만 직접 고친다
 * (매 pointermove마다 화면 전체가 리렌더링되지 않게). 놓을 때 한 번만 상태에 반영한다.
 * onMove(참조 안정적)는 드래그 중 매 이동마다 불린다 — 다른 DOM·Canvas를 직접 따라오게 할 때 쓴다.
 * rev: 크기를 바꿀 패널이 splitter **바로 뒤**에 있다(오른쪽 열의 왼쪽 경계). 왼쪽으로 끌면 커진다.
 * 세 번째 값 reset()은 초기값으로 되돌리고 저장값을 지운다 (더블클릭과 같다). initial이 0이면 "자동"으로 쓸 수 있다(0이면 보이는 크기에서 드래그 시작).
 */
export function useSplit(key: string, initial: number, min: number, max: number, axis: "x" | "y", onMove?: (size: number) => void, rev?: boolean) {
  return useSplitImpl(key, initial, min, max, axis, onMove, false, rev);
}

/**
 * 부모 크기에 대한 비율(0~1)로 저장하는 분할. 창 크기가 바뀌어도 두 패널이 같은 비율로 함께 늘고 준다.
 * size는 비율이라 style에는 `${size * 100}%`로 쓴다. min·max는 px로, 드래그할 때 부모 크기로 환산해 지킨다.
 */
export function useRatioSplit(key: string, initial: number, minPx: number, restPx: number, axis: "x" | "y") {
  return useSplitImpl(key, initial, minPx, restPx, axis, undefined, true);
}

function useSplitImpl(key: string, initial: number, min: number, max: number, axis: "x" | "y", onMove: ((size: number) => void) | undefined, ratio: boolean, rev = false) {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem("split:" + key));
      return ratio ? (v > 0 && v < 1 ? v : initial) : v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });

  const reset = () => {
    setSize(initial);
    try {
      localStorage.removeItem("split:" + key);
    } catch {}
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const pane = (rev ? (e.currentTarget as HTMLElement).nextElementSibling : (e.currentTarget as HTMLElement).previousElementSibling) as HTMLElement;
    const sign = rev ? -1 : 1;
    const prop = axis === "x" ? "width" : "height";
    const start = axis === "x" ? e.clientX : e.clientY;
    // CSS max-*로 줄어 보이면 보이는 크기에서 시작한다. onMove를 쓰는 곳은 패널 크기가 곧 분할 크기가 아니라서 제외.
    const total = ratio ? (pane.parentElement?.getBoundingClientRect()[prop] ?? 1) : 0;
    const from = onMove && size > 0 ? size : pane.getBoundingClientRect()[prop];
    let last = ratio ? size : from;
    let moved = false;
    const move = (ev: PointerEvent) => {
      // ratio: min = 앞 패널 최소 px, max = 뒤 패널에 남길 최소 px
      const px = Math.min(ratio ? total - max : max, Math.max(min, from + sign * ((axis === "x" ? ev.clientX : ev.clientY) - start)));
      moved = true;
      last = ratio ? px / total : px;
      pane.style[prop] = ratio ? last * 100 + "%" : px + "px";
      onMove?.(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-" + axis);
      if (!moved) return; // 클릭만 했으면 저장하지 않는다 (자동 크기가 고정값으로 바뀌지 않게)
      setSize(last);
      try {
        localStorage.setItem("split:" + key, String(last));
      } catch {}
    };
    document.body.classList.add("resizing-" + axis);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const splitter = (
    <div
      className={"splitter " + axis}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
    />
  );
  return [size, splitter, reset] as const;
}
