import { IS_VSCODE } from "../../shared/api/bridge";
import { t } from "../../shared/i18n/i18n";
import { ops, revealLabel } from "../../shared/model/ops";
import type { MenuEntry } from "../../shared/ui/menu";
import { inspect } from "./Inspector";

/** 파일 우클릭 공통: 파일 관리자에서 보기, 기본 앱으로 열기, 사용자 정의 명령(파일 대상) */
export const fileOpenMenu = (path: string, rev: string | null): MenuEntry[] => [
  ...(IS_VSCODE ? [{ label: t("details.openEditor"), action: () => ops.openInEditor(path, rev) }] : []),
  { label: revealLabel(), action: () => ops.reveal(path) },
  { label: t("details.openDefault"), action: () => ops.openDefault(path) },
  ...ops.customMenu("file", { file: path, sha: rev ?? undefined }),
];

/** 순서: 히스토리·Blame → 외부 도구·열기 → 경로 복사 → 이 버전으로 되돌리기(커밋 파일)
 * rev가 있으면 그 커밋의 파일, 없으면 작업 디렉터리 파일(staged: 스테이지된 쪽) */
export const fileMenu = (path: string, rev: string | null, staged = false): MenuEntry[] => [
  { label: t("details.history"), action: () => inspect.history(path) },
  { label: "Blame", action: () => inspect.blame(path, rev) },
  ...(rev ? [{ label: t("details.viewAtRev"), action: () => inspect.file(path, rev) }] : []),
  { separator: true },
  { label: t("details.difftool"), action: () => (rev ? ops.difftoolCommit(rev, path) : ops.difftoolChanges(path, staged)) },
  ...fileOpenMenu(path, rev),
  { separator: true },
  { label: t("details.copyPath"), action: () => ops.copy(path) },
  ...(rev ? [{ separator: true } as MenuEntry, { label: t("details.restoreVersion"), op: "restore_file", action: () => ops.restoreFile(path, rev) }] : []),
];
