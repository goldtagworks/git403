import { memo, useEffect, useRef } from "react";
import { api } from "../../shared/api/api";
import { t, useLocale } from "../../shared/i18n/i18n";
import { gh, useGh } from "../../shared/model/gh";
import { ctx } from "../../shared/model/ops";
import { showMenu, type MenuEntry } from "../../shared/ui/menu";
import { countRender } from "../../shared/lib/profile";
import { StatusItem } from "../../shared/ui/StatusItem";

/**
 * 상태바 왼쪽(브랜치 옆)의 gh 계정 항목: 활성 계정, 연결 계정이 다르면 "연결계정 ↔".
 * 클릭 메뉴: 계정 전환·이 저장소에 연결/해제·원격 접근 확인. 자기 스토어(`gh.ts`)만 구독한다.
 */
export const GhStatusItem = memo(function GhStatusItem() {
  countRender("GhStatusItem");
  useLocale();
  const at = useRef({ x: 0, y: 0 }); // 메뉴 위치: 클릭 때 항목 위치를 저장, probe 결과 메뉴도 같은 자리
  const s = useGh();
  // 외부에서 `gh auth switch`를 했을 수 있으니 창이 포커스를 받으면 가볍게 다시 읽는다
  useEffect(() => {
    const f = () => void gh.refresh(ctx.repo || undefined, true);
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);
  if (!s) return null;
  const differs = !!s.bound && s.bound !== s.active;
  const label = differs ? `${s.active ?? "-"} → ${s.bound}` : s.active ?? t("gh.none");
  const title = differs ? t("gh.tipBound", { bound: s.bound!, active: s.active ?? "-" }) : s.bound ? t("gh.tipBoundSame", { user: s.bound }) : t("gh.tip", { user: s.active ?? "-" });

  const fail = (e: unknown) => ctx.error(String(e));
  const act = (f: () => Promise<unknown>) => () => void f().catch(fail);
  const build = (probe: Record<string, boolean> | null): MenuEntry[] => [
    ...s.accounts.map((a) => ({
      label: a.user, checked: a.active,
      hint: probe && a.user in probe ? t(probe[a.user] ? "gh.probeOk" : "gh.probeNo") : undefined,
      action: act(() => gh.switchTo(s.host, a.user)),
    })),
    { separator: true as const },
    ...s.accounts.filter((a) => a.user !== s.bound).map((a) => ({ label: t("gh.bind", { user: a.user }), action: act(() => gh.bindTo(s.repo, a.user)) })),
    ...(s.bound ? [{ label: t("gh.unbind"), action: act(() => gh.bindTo(s.repo)) }] : []),
    { label: t("gh.probe"), action: () => void api.ghProbe(s.repo).then((r) => showMenu(build(Object.fromEntries(r.map((p) => [p.user, p.ok]))), at.current), fail) },
  ];
  return (
    <StatusItem
      name={t("gh.name")}
      label={label}
      title={title}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        at.current = { x: r.left, y: r.top - 4 };
        showMenu(build(null), at.current);
      }}
    />
  );
});
