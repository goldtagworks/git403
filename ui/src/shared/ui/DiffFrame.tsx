import type { ReactNode } from "react";

/**
 * diff 화면의 틀: 한쪽 열(`side`: 커밋 정보·파일 목록 등) + 분할선(`split`) + 넓은 영역(`children`: diff).
 * 평소엔 side가 왼쪽이고, 크게 보기(`bigView`, `<html data-big>`)에서는 CSS가 side를 오른쪽 세로 전체로 옮기고
 * 이 틀의 부모(`.main`)가 그래프 자리까지 차지하게 한다. 마크업 계약: `.details > .info + .splitter + .diff-wrap|.diff-pane`.
 * PR 리뷰 화면도 이 틀에 side(파일 목록·코멘트)와 diff를 넣으면 크게 보기 레이아웃을 그대로 쓴다.
 */
export function DiffFrame({ side, split, children }: { side: ReactNode; split: ReactNode; children: ReactNode }) {
  return (
    <div className="details">
      {side}
      {split}
      {children}
    </div>
  );
}
