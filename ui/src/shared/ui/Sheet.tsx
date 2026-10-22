import { createContext, createElement, useCallback, useContext, useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { focusSheet } from "../lib/sheet";
import { t, useLocale } from "../i18n/i18n";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

// 모든 팝업(시트)의 공용 틀: 배경 · role=dialog · 첫 포커스 · Esc 닫기 · Enter = 주 버튼. 순수 표시, 상태는 갖지 않는다.
// 구성: <Sheet><SheetHead/><SheetBody/><SheetActions/></Sheet>. 모든 시트는 머리줄 [제목 …… ✕] + 바닥 [취소|닫기 (주 버튼)]을 둔다(빠른 실행 팔레트만 예외).
// ✕와 취소·닫기는 Sheet의 onClose를 기본으로 쓴다.

const SheetClose = createContext<(() => void) | undefined>(undefined);

export type SheetSize = "default" | "wide" | "settings" | "inspector" | "reader" | "palette";

interface SheetProps {
  /** aria-label (E2E·스크린리더용 이름) */
  label: string;
  onClose: () => void;
  size?: SheetSize;
  /** 창 거의 전체로 키운 상태(inspector·reader) */
  big?: boolean;
  /** 위쪽 고정(빠른 실행처럼 높이가 바뀌는 팝업). 기본은 화면 가운데 */
  top?: boolean;
  /** 배경을 누르면 닫는다(입력 내용이 없는 조회용 팝업만. 입력 시트는 끄는 게 기본) */
  closeOnBackdrop?: boolean;
  /** Esc를 직접 처리해야 할 때(예: 크게 보기부터 풀기). 기본은 onClose */
  onEscape?: () => void;
  /** 시트 안 키 입력을 먼저 본다. preventDefault하면 Esc·Enter 기본 동작을 건너뛴다 */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** 주는 순간 form이 된다 (입력칸에서 Enter = submit) */
  onSubmit?: (e: FormEvent) => void;
  /** 시트 요소 ref (포커스 되돌리기용) */
  dialogRef?: Ref<HTMLElement>;
  className?: string;
  children: ReactNode;
}

const NO_ENTER = "button, a, select, textarea, summary, [contenteditable]";

/** 배경 + 대화상자. Esc는 맨 위 시트 하나만 닫고(stopPropagation), Enter는 주 버튼(`.sheet-actions .primary·.danger`)을 누른다 */
export function Sheet({ label, onClose, size = "default", big, top, closeOnBackdrop, onEscape, onKeyDown, onSubmit, dialogRef, className, children }: SheetProps) {
  // 닫힐 때 열기 전 포커스(눌렀던 버튼 등)로 돌아간다. 그 요소가 사라졌거나 다른 곳에 포커스가 있으면 건드리지 않는다
  const from = useRef<Element | null | undefined>(undefined);
  if (from.current === undefined) from.current = document.activeElement;
  useEffect(() => () => {
    const el = from.current;
    requestAnimationFrame(() => {
      if (el instanceof HTMLElement && el !== document.body && el.isConnected && (!document.activeElement || document.activeElement === document.body)) el.focus();
    });
  }, []);
  const ref = useCallback((el: HTMLElement | null) => {
    focusSheet(el);
    if (typeof dialogRef === "function") dialogRef(el);
    else if (dialogRef) (dialogRef as { current: HTMLElement | null }).current = el;
  }, [dialogRef]);
  const key = (e: KeyboardEvent) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      (onEscape ?? onClose)();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const el = e.target as HTMLElement;
      const input = el instanceof HTMLInputElement && el.type !== "checkbox" && el.type !== "radio";
      if (input || el.matches(NO_ENTER)) return; // 입력칸·버튼·링크의 Enter는 각자 기본 동작(입력칸 submit은 form이)
      const primary = e.currentTarget.querySelector<HTMLButtonElement>(":scope > .sheet > .sheet-actions > .primary:not(:disabled), :scope > .sheet > .sheet-actions > .danger:not(:disabled)");
      if (primary) (e.preventDefault(), primary.click());
    }
  };
  const cls = ["sheet", size !== "default" && size, big && "big", className].filter(Boolean).join(" ");
  return (
    <div
      className={"sheet-backdrop" + (top ? " top" : "")}
      onKeyDown={key}
      onMouseDown={closeOnBackdrop ? (e) => e.target === e.currentTarget && onClose() : undefined}
    >
      <SheetClose.Provider value={onClose}>
        {createElement(onSubmit ? "form" : "div", { className: cls, role: "dialog", tabIndex: -1, ref, "aria-label": label, ...(onSubmit ? { onSubmit } : {}) }, children)}
      </SheetClose.Provider>
    </div>
  );
}

/** 머리줄: 제목(h2) + 오른쪽 보조 도구(`tools`) + 닫기 ✕(항상, 기본은 Sheet의 onClose). 제목 옆 내용(`children`)은 흐린 부제·배지 등 */
export function SheetHead({ title, icon, children, tools, onClose: own, className }: { title?: ReactNode; icon?: IconName; children?: ReactNode; tools?: ReactNode; onClose?: () => void; className?: string }) {
  useLocale();
  const ctx = useContext(SheetClose);
  const onClose = own ?? ctx;
  return (
    <header className={"sheet-head" + (className ? " " + className : "")}>
      <h2>
        {icon && <Icon name={icon} size={15} />}
        {title}
        {children}
      </h2>
      {(tools || onClose) && (
        <span className="sheet-tools">
          {tools}
          {onClose && <button type="button" className="icon-btn" aria-label={t("common.close")} title={`${t("common.close")} (Esc)`} onClick={onClose}><Icon name="dismiss" size={14} /></button>}
        </span>
      )}
    </header>
  );
}

/** 본문. 기본은 세로로 쌓고 넘치면 스크롤. `flush`는 여백·간격 없이(안쪽이 자기 스크롤·여백을 가질 때) */
export function SheetBody({ children, flush, className }: { children: ReactNode; flush?: boolean; className?: string }) {
  return <div className={"sheet-body" + (flush ? " flush" : "") + (className ? " " + className : "")}>{children}</div>;
}

interface ActionsProps {
  /** 왼쪽 보조 버튼·링크 (예: "계정 연결…"). 주 버튼과 떨어져 왼쪽에 놓인다 */
  aside?: ReactNode;
  /** 취소·닫기 버튼 글자. 기본 "취소"(작업을 안 하고 나감), 결과만 보는 시트는 "닫기". false면 안 그린다 */
  cancel?: string | false;
  onCancel?: () => void;
  /** 주 버튼 글자. 맨 오른쪽, Enter로 눌린다. 없으면 취소·닫기만 */
  primary?: ReactNode;
  /** form 안이면 submit(기본), 아니면 onPrimary로 */
  onPrimary?: () => void;
  /** 위험 작업(삭제·강제): 주 버튼이 danger 색 */
  danger?: boolean;
  disabled?: boolean;
  /** 주 버튼이 비활성인 이유. 왼쪽에 흐린 글자로 보이고 버튼 툴팁이 된다 */
  reason?: string;
  /** 시트가 열릴 때 주 버튼에 첫 포커스(입력칸이 없는 확인 시트) */
  autoFocus?: boolean;
}

/** 바닥 버튼줄: [보조 …… 취소 주버튼]. 주 버튼은 맨 오른쪽, 취소는 그 왼쪽 */
export function SheetActions({ aside, cancel, onCancel: own, primary, onPrimary, danger, disabled, reason, autoFocus }: ActionsProps) {
  useLocale();
  const ctx = useContext(SheetClose);
  const onCancel = own ?? ctx;
  const cancelLabel = cancel === undefined ? t("common.cancel") : cancel;
  return (
    <div className="sheet-actions">
      {(aside || (reason && disabled)) && (
        <span className="sheet-aside">
          {reason && disabled && <span className="sheet-reason" role="status">{reason}</span>}
          {aside}
        </span>
      )}
      {cancelLabel !== false && <button type="button" onClick={onCancel}>{cancelLabel}</button>}
      {primary != null && (
        <button type={onPrimary ? "button" : "submit"} className={danger ? "danger" : "primary"} disabled={disabled} title={disabled ? reason : undefined} autoFocus={autoFocus} onClick={onPrimary}>
          {primary}
        </button>
      )}
    </div>
  );
}
