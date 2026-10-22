// 우클릭 메뉴(커밋·브랜치·태그·스태시)가 같이 쓰는 항목 묶음. 동작은 전부 ops.
import { t } from "../i18n/i18n";
import type { MenuEntry } from "../ui/menu";
import type { Ref } from "../api/types";
import { ops } from "./ops";

/** Reset ▸ 방식 선택…·Soft·Mixed·Hard (모드를 고르면 선택창 없이 실행, hard는 확인창) */
export const resetMenu = (sha: string): MenuEntry => ({
  label: t("menu.reset"),
  submenu: [
    { label: t("graph.reset"), action: () => ops.reset(sha) },
    { separator: true },
    { label: t("menu.resetSoft"), action: () => ops.reset(sha, "--soft") },
    { label: t("menu.resetMixed"), action: () => ops.reset(sha, "--mixed") },
    { label: t("menu.resetHard"), action: () => ops.reset(sha, "--hard") },
  ],
});

/** 이 커밋 기준 작업: 브랜치 만들기 · cherry-pick · Reset ▸ · Revert */
export const atCommit = (sha: string): MenuEntry[] => [
  { label: t("graph.newBranch"), action: () => ops.createBranch(sha) },
  { label: "cherry-pick", action: () => ops.cherryPick(sha) },
  resetMenu(sha),
  { label: t("graph.revert"), action: () => ops.revert(sha) },
];

/** 스태시 항목: 적용 · pop · 삭제 · 메시지 바꾸기 (사이드바와 그래프의 스태시 노드 공용) */
export const stashMenu = (r: Pick<Ref, "name" | "message">): MenuEntry[] => [
  { label: t("sidebar.apply"), action: () => ops.applyStash(r.name) },
  { label: t("sidebar.pop"), action: () => ops.pop(r.name) },
  { label: t("sidebar.delete"), action: () => ops.dropStash(r.name) },
  { label: t("sidebar.rename"), action: () => ops.renameStash(r.name, r.message) },
];
