import { memo, useEffect, useRef } from "react";
import { api } from "../../shared/api/api";
import { t, useLocale } from "../../shared/i18n/i18n";
import { gh, useGh } from "../../shared/model/gh";
import { ctx, ops } from "../../shared/model/ops";
import { showMenu, type MenuEntry } from "../../shared/ui/menu";
import { pref } from "../../shared/lib/settings";
import { countRender } from "../../shared/lib/profile";
import { StatusItem } from "../../shared/ui/StatusItem";

/** 정보 줄(비활성)용: MenuEntry가 action을 요구하고 비활성 항목은 눌리지 않는다 */
const NOP = () => {};
/** 저장소별 커밋 작성자 캐시(메뉴를 바로 띄우려고). 설정·해제 뒤에는 지운다 */
const whoCache = new Map<string, { name: string; email: string; local: boolean }>();

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

  const withWho = (f: () => Promise<unknown>) => async () => { try { await f(); } finally { whoCache.delete(s.repo); } };
  const fail = (e: unknown) => ctx.error(String(e));
  const act = (f: () => Promise<unknown>) => () => void f().catch(fail);
  type Who = { name: string; email: string; local: boolean };
  const build = (probe: Record<string, boolean> | null, who?: Who): MenuEntry[] => [
    ...s.accounts.map((a) => ({
      label: a.user, checked: a.active,
      hint: probe && a.user in probe ? t(probe[a.user] ? "gh.probeOk" : "gh.probeNo") : undefined,
      // 자동 전환을 켜 두면 전환한 계정을 이 저장소에 연결해 다음에 열 때·탭을 옮길 때 다시 전환되게 한다
      action: act(async () => {
        await gh.switchTo(s.host, a.user);
        if (pref("ghAutoSwitch") && a.user !== s.bound) await gh.bindTo(s.repo, a.user);
      }),
    })),
    { separator: true as const },
    ...s.accounts.filter((a) => a.user !== s.bound).map((a) => ({ label: t("gh.bind", { user: a.user }), action: act(() => gh.bindTo(s.repo, a.user)) })),
    ...(s.bound ? [{ label: t("gh.unbind"), action: act(() => gh.bindTo(s.repo)) }] : []),
    { label: t("gh.probe"), action: () => void api.ghProbe(s.repo).then((r) => showMenu(build(Object.fromEntries(r.map((p) => [p.user, p.ok])), who), at.current), fail) },
    { label: t("gh.autoSwitch"), checked: pref("ghAutoSwitch"), action: () => ops.setPref("ghAutoSwitch", !pref("ghAutoSwitch")) },
    ...(who ? [
      { separator: true as const },
      { label: t("gh.author", { name: who.name || "-", email: who.email || "-", scope: t(who.local ? "gh.authorLocal" : "gh.authorGlobal") }), disabled: true, action: NOP },
      { label: t("gh.authorSet"), action: act(withWho(ops.authorSet)) },
      ...(who.local ? [{ label: t("gh.authorUnset"), action: act(withWho(ops.authorUnset)) }] : []),
    ] : []),
  ];
  return (
    <StatusItem
      name={t("gh.name")}
      label={label}
      title={title}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        at.current = { x: r.left, y: r.top - 4 };
        // 작성자 줄은 저장소별 캐시로 바로 보이고, 읽은 값이 다르면 메뉴를 같은 자리에 다시 연다(probe 패턴). 처음엔 읽고 나서 연다
        const cached = whoCache.get(s.repo);
        if (cached) showMenu(build(null, cached), at.current);
        ops.authorRead().then((who) => {
          const changed = !cached || JSON.stringify(cached) !== JSON.stringify(who);
          whoCache.set(s.repo, who);
          if (changed) showMenu(build(null, who), at.current);
        }, (err) => { ctx.error(String(err)); if (!cached) showMenu(build(null), at.current); });
      }}
    />
  );
});
