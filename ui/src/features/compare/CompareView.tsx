import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { Commit, RefCompare } from "../../shared/api/types";
import { t, useLocale } from "../../shared/i18n/i18n";
import { countRender } from "../../shared/lib/profile";
import { relTime } from "../../shared/lib/reltime";
import { compare, useCompare } from "../../shared/model/compare";
import { dnd } from "../../shared/model/dnd";
import { atCommit } from "../../shared/model/menus";
import { ctx, ops } from "../../shared/model/ops";
import { isMulti } from "../../shared/model/selection";
import { contextMenu, type MenuEntry } from "../../shared/ui/menu";
import { Sha } from "../../shared/ui/Sha";

type Side = "a" | "b";
interface Sel { side: Side; ids: ReadonlySet<string> }
const PAGE = 200; // 한 번에 그리는 행 수 (목록은 최대 5000개라 나눠서 그린다)

/** 비교 화면의 위쪽: 두 브랜치 각각에만 있는 커밋 목록. 커밋을 고르면 아래 상세(`CompareDetails`)가 바뀐다. 행은 드래그해 현재 브랜치에 cherry-pick할 수 있다 */
export const CompareLists = memo(function CompareLists({ repo }: { repo: string }) {
  const id = useCompare()?.id;
  return id === undefined ? null : <Lists key={id} repo={repo} />; // 열 때마다(같은 쌍도) 새로 마운트: 이전 목록·선택·더 보기가 남지 않는다
});

function Lists({ repo }: { repo: string }) {
  countRender("CompareLists");
  useLocale();
  const cmp = useCompare();
  const [data, setData] = useState<RefCompare | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [shown, setShown] = useState({ a: PAGE, b: PAGE });
  const selRef = useRef(sel);
  selRef.current = sel;
  const dataRef = useRef(data);
  dataRef.current = data;
  const [a, b, rev] = [cmp?.a, cmp?.b, cmp?.rev];

  useEffect(() => {
    if (a === undefined || b === undefined) return;
    let live = true;
    api.compareRefs(repo, a, b).then(
      (d) => {
        if (!live) return;
        setData(d);
        // 다시 읽은 뒤에도 남아 있는 선택은 유지하고, 없으면 첫 커밋
        const keep = selRef.current;
        const list = keep ? d[keep.side === "a" ? "onlyA" : "onlyB"] : [];
        const left = keep ? list.filter((c) => keep.ids.has(c.id)) : [];
        if (left.length) return setSel({ side: keep!.side, ids: new Set(left.map((c) => c.id)) });
        const first = d.onlyA[0] ?? d.onlyB[0];
        setSel(first ? { side: d.onlyA[0] ? "a" : "b", ids: new Set([first.id]) } : null);
        compare.setCommit(first ?? null);
      },
      (e) => live && (ctx.error(String(e)), compare.close()),
    );
    return () => void (live = false);
  }, [repo, a, b, rev]);
  useEffect(() => () => compare.setCommit(null), []);

  const side = (s: Side) => (s === "a" ? dataRef.current?.onlyA : dataRef.current?.onlyB) ?? [];
  const pick = useCallback((s: Side, c: Commit, e: React.MouseEvent) => {
    const cur = selRef.current;
    if (isMulti(e)) {
      const ids = new Set(cur?.side === s ? cur.ids : []);
      if (ids.has(c.id)) {
        // 해제: 상세는 남은 선택 중 하나(없으면 비움)
        ids.delete(c.id);
        setSel(ids.size ? { side: s, ids } : null);
        return compare.setCommit(side(s).find((x) => ids.has(x.id)) ?? null);
      }
      ids.add(c.id);
      setSel({ side: s, ids });
    } else if (cur?.side === s && cur.ids.size > 1 && cur.ids.has(c.id)) return; // 드래그할 수 있게 유지
    else setSel({ side: s, ids: new Set([c.id]) });
    compare.setCommit(c);
  }, []);
  const chosen = useCallback((s: Side, c: Commit) => {
    const cur = selRef.current;
    return cur?.side === s && cur.ids.size > 1 && cur.ids.has(c.id) ? side(s).filter((x) => cur.ids.has(x.id)) : [c];
  }, []);
  const drag = useCallback((s: Side, e: React.PointerEvent, c: Commit) => {
    if (isMulti(e) || e.shiftKey) return;
    dnd.begin(e.nativeEvent, chosen(s, c), () => (setSel({ side: s, ids: new Set([c.id]) }), compare.setCommit(c)));
  }, [chosen]);
  const menu = useCallback((s: Side, c: Commit): MenuEntry[] => {
    const list = chosen(s, c);
    return list.length > 1
      ? [{ label: t("compare.pickN", { n: list.length }), op: "cherry-pick", action: () => ops.cherryPickMany(list) }]
      : [...atCommit(c.id), { separator: true }, { label: t("graph.copySha"), action: () => ops.copy(c.id) }];
  }, [chosen]);

  if (!cmp) return null;
  return (
    <div className="cmp">
      <div className="wide-bar">
        <button className="back" onClick={compare.close}>← {t("app.backToGraph")}</button>
        <span className="cmp-title" title={`${cmp.an} ↔ ${cmp.bn}`}>{cmp.an} ↔ {cmp.bn}</span>
      </div>
      <div className="cmp-cols">
        {(["a", "b"] as const).map((s) => {
          const name = s === "a" ? cmp.an : cmp.bn;
          const list = data ? (s === "a" ? data.onlyA : data.onlyB) : [];
          const n = shown[s];
          return (
            <section key={s} className="cmp-col" data-side={s}>
              <h3 className="files-head"><span>{t("compare.onlyIn", { name, n: list.length })}</span></h3>
              <ul className="files" role="listbox" aria-multiselectable="true" aria-label={t("compare.onlyIn", { name, n: list.length })}>
                {list.slice(0, n).map((c) => (
                  <CmpRow key={c.id} c={c} side={s} selected={sel?.side === s && sel.ids.has(c.id)} onPick={pick} onDrag={drag} onMenu={menu} />
                ))}
                {list.length > n && (
                  <li className="cmp-more"><button onClick={() => setShown((v) => ({ ...v, [s]: v[s] + PAGE }))}>{t("compare.more", { n: list.length - n })}</button></li>
                )}
                {data && !list.length && <li className="muted cmp-none">{data.onlyA.length + data.onlyB.length ? t("compare.none") : t("compare.same")}</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const CmpRow = memo(function CmpRow({ c, side, selected, onPick, onDrag, onMenu }: { c: Commit; side: Side; selected: boolean; onPick: (s: Side, c: Commit, e: React.MouseEvent) => void; onDrag: (s: Side, e: React.PointerEvent, c: Commit) => void; onMenu: (s: Side, c: Commit) => MenuEntry[] }) {
  useLocale();
  countRender("CompareRow");
  return (
    <li
      role="option"
      aria-selected={selected}
      className={selected ? "selected" : ""}
      onPointerDown={(e) => e.button === 0 && onDrag(side, e, c)}
      onMouseDown={(e) => e.button === 0 && onPick(side, c, e)}
      onContextMenu={contextMenu(() => onMenu(side, c))}
    >
      <span className="h-subject" title={c.subject}>{c.subject}</span>
      <span className="h-meta muted"><Sha id={c.id} /> · {c.author} · {relTime(c.time)}</span>
    </li>
  );
});

