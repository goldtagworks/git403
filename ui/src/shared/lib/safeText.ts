// 불신 문자열(북마크·원격 이름, 커밋·operation 설명, user, 백엔드 오류의 변수)을 화면·OS 다이얼로그에 넣기 전에 거친다.
// 보이지 않는 서식 문자(Cf: 방향 뒤집기·폭 없는 문자)·제어문자(Cc)·줄 구분(Zl/Zp)을 `⟦U+202E⟧`처럼 눈에 보이는 표기로 바꿔 이름·문구 위장을 막는다.
// 표시용일 뿐이다: 백엔드에 보내는 값은 원본 그대로(docs/security.md jj 모드).
const BAD = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu;
const WS = /[\n\r\t]/;

/** keepWs = 줄바꿈·탭은 그대로 둔다(여러 줄 오류 문구용). 이름·ask 본문에는 쓰지 않는다 */
export const visibleText = (s: string, keepWs = false): string =>
  s.replace(BAD, (ch) => (keepWs && WS.test(ch) ? ch : `⟦U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`));
