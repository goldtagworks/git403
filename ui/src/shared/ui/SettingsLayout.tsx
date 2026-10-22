import { cloneElement, createContext, isValidElement, useContext, useId, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

// 설정 창 공용 레이아웃(VS Code 설정 화면식): 그룹(SettingsGroup) 안에 항목(SettingsItem)을 세로로 쌓는다.
// 항목 = 굵은 제목 → 회색 설명 → 컨트롤(왼쪽 정렬). 카드·테두리 없음. 상태는 갖지 않는다(순수 표시).
// 설정 검색: 창이 SettingsQuery.Provider로 검색어를 내려 주면 제목·설명(문자열)에 없는 항목은 그리지 않는다.

export const SettingsQuery = createContext("");

/** 항목 묶음: 작은 제목 + 항목들 + (선택) 아래 설명 */
export function SettingsGroup({ title, note, children }: { title?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="sgroup">
      {title != null && <h3 className="sgroup-title">{title}</h3>}
      <div className="sgroup-card">{children}</div>
      {note != null && <p className="sgroup-note">{note}</p>}
    </section>
  );
}

const text = (n: ReactNode) => (typeof n === "string" ? n : "");

/**
 * 한 항목. children이 input/select 하나면 제목을 aria-labelledby로 이어 `getByLabel(제목)`으로 찾히게 한다(aria-label이 이미 있으면 그대로).
 * 체크박스는 제목·설명 앞에 붙인다. 제목 없이 컨트롤만 두면 컨트롤만 그린다(단독 버튼).
 * `cat`은 "분류: 이름"의 흐린 앞부분.
 */
export function SettingsItem({ name, cat, desc, children }: { name?: ReactNode; cat?: ReactNode; desc?: ReactNode; children: ReactNode }) {
  const id = useId();
  const q = useContext(SettingsQuery).trim().toLowerCase();
  if (q && name != null && !`${text(cat)} ${text(name)} ${text(desc)}`.toLowerCase().includes(q)) return null;
  if (q && name == null) return null;
  const el = isValidElement(children) ? (children as ReactElement<HTMLAttributes<HTMLElement> & { type?: string }>) : null;
  const single = !!el && typeof el.type === "string" && ["input", "select", "textarea"].includes(el.type);
  const check = single && el!.props.type === "checkbox";
  const ctl = single && name != null && !el!.props["aria-label"]
    ? cloneElement(el!, { "aria-labelledby": `${id}n`, ...(desc != null ? { "aria-describedby": `${id}d` } : {}) })
    : children;
  const head = name != null && (
    <div className="sitem-text">
      <span className="sitem-name" id={`${id}n`}>{cat != null && <span className="sitem-cat">{cat}: </span>}{name}</span>
      {desc != null && <span className="sitem-desc" id={`${id}d`}>{desc}</span>}
    </div>
  );
  if (check) return <div className="sitem check"><div className="sitem-ctl">{ctl}</div>{head}</div>;
  return <div className={"sitem" + (name == null ? " bare" : "")}>{head}<div className="sitem-ctl">{ctl}</div></div>;
}
/** 예전 이름(행) 호환 */
export const SettingsRow = SettingsItem;

/** 그룹 안의 설명·상태 한 줄 */
export function SettingsNote({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} className={"snote " + (rest.className ?? "")}>{children}</p>;
}

/** 그룹 안의 자유 블록(목록·편집기 등) */
export function SettingsBlock({ children }: { children: ReactNode }) {
  return <div className="sblock">{children}</div>;
}
