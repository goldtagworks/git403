import { useEffect, useSyncExternalStore } from "react";
import { ops } from "../../shared/model/ops";
import { onPrefs, pref } from "../../shared/lib/settings";

/** 자동 fetch 타이머. 화면은 없고, 간격 설정이 바뀔 때만 다시 그려진다 */
/** 자동 fetch: 켜져 있으면 저장소를 열거나 탭을 바꿀 때 한 번(그래프를 다 읽은 뒤), 이후 간격마다 */
export function AutoFetch({ repo }: { repo: string }) {
  const minutes = useSyncExternalStore(onPrefs, () => pref("autoFetch"));
  useEffect(() => {
    if (!pref("autoFetch") || !repo || ops.aiRunning(repo)) return; // 간격 설정을 바꿀 때는 돌지 않게 repo에만 반응한다. AI 차례가 도는 저장소에는 예약하지 않는다
    const id = setTimeout(ops.autoFetch, 1500);
    return () => clearTimeout(id);
  }, [repo]);
  useEffect(() => {
    if (!minutes) return;
    const id = setInterval(ops.autoFetch, minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes]);
  return null;
}
