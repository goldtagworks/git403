import type { ReactNode } from "react";

/**
 * 상태바 항목 버튼 (왼쪽 gh 계정, 오른쪽 AI 등). 평평한 글자 버튼이고 `muted`면 흐리게 보인다.
 * 상태는 갖지 않는다 — 값을 구독하는 건 항목을 쓰는 컴포넌트가 한다.
 */
export function StatusItem({ icon, name, label, title, muted, onClick }: { icon?: ReactNode; /** 흐린 이름표 접두("GitHub 계정"). 좁은 창에서 먼저 숨는다 */ name?: string; label: string; title?: string; muted?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`status-item${muted ? " muted" : ""}`} title={title} onClick={onClick}>
      {icon}
      {name && <><span className="si-name">{name}</span>{" "}</>}
      <span className="si-val">{label}</span>
    </button>
  );
}
