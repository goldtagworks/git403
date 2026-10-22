import { useEffect, useMemo, useState } from "react";
import { api } from "../../shared/api/api";
import { dateFmt, intlTag, t, useLocale, type Key } from "../../shared/i18n/i18n";
import { ctx } from "../../shared/model/ops";
import type { AuthorStat, Stats, StatsRange } from "../../shared/api/types";

const RANGES: [StatsRange, Key][] = [["all", "stats.range.all"], ["year", "stats.range.year"], ["90d", "stats.range.90d"], ["30d", "stats.range.30d"]];
const DAYS: Key[] = ["stats.day0", "stats.day1", "stats.day2", "stats.day3", "stats.day4", "stats.day5", "stats.day6"];
const nums = new Map<string, Intl.NumberFormat>();
const num = { format: (n: number) => (nums.get(intlTag()) ?? nums.set(intlTag(), new Intl.NumberFormat(intlTag())).get(intlTag())!).format(n) };
const day = (s: number | null) => (s == null ? "—" : dateFmt({ dateStyle: "medium" }).format(s * 1000));
const size = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GiB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MiB` : `${kb} KiB`);

let seq = 0;
type SortKey = "name" | "commits" | "added" | "deleted" | "last";
const COLS: [SortKey, Key][] = [["name", "stats.col.name"], ["commits", "stats.col.commits"], ["added", "stats.col.added"], ["deleted", "stats.col.deleted"], ["last", "stats.col.last"]];

/** 저장소 통계 (Inspector 시트 안). 집계는 Rust(`repo_stats`)가 하고 여기선 그리기만 한다. */
export function StatsPanel() {
  useLocale();
  const [range, setRange] = useState<StatsRange>("all");
  const [branch, setBranch] = useState<string | null>(null);
  const [withLines, setWithLines] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "commits", dir: -1 });
  const branches = useMemo(() => ctx.refs.filter((r) => r.kind === "local").map((r) => r.name), []);
  const repo = ctx.repo;

  // 인자가 바뀌거나 시트가 닫히면(언마운트) 진행 중인 계산을 취소하고, 늦게 도착한 결과는 버린다.
  useEffect(() => {
    let stale = false;
    const token = `${Date.now()}-${++seq}`;
    setLoading(true);
    api.repoStats(repo, range, branch, withLines, token).then(
      (s) => !stale && (setStats(s), setLoading(false)),
      (e) => !stale && (ctx.error(String(e)), setLoading(false)),
    );
    return () => {
      stale = true;
      api.cancelStats(token).catch(() => {});
    };
  }, [repo, range, branch, withLines]);

  const authors = useMemo(() => {
    const list = [...(stats?.authors ?? [])];
    const get = (a: AuthorStat) => a[sort.key];
    return list.sort((a, b) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0) * sort.dir);
  }, [stats, sort]);
  const clickSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }));

  return (
    <div className="stats" aria-busy={loading}>
      <div className="stats-bar">
        <div role="group" aria-label={t("stats.period")} className="seg">
          {RANGES.map(([v, label]) => (
            <button key={v} aria-pressed={range === v} onClick={() => setRange(v)}>{t(label)}</button>
          ))}
        </div>
        <select aria-label={t("stats.branch")} value={branch ?? ""} onChange={(e) => setBranch(e.target.value || null)}>
          <option value="">{t("stats.allBranches")}</option>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label>
          <input type="checkbox" checked={withLines} onChange={(e) => setWithLines(e.target.checked)} /> {t("stats.withLines")}
        </label>
        {loading && <span className="muted" role="status">{t("stats.calculating")}</span>}
      </div>
      {stats && <StatsBody stats={stats} authors={authors} sort={sort} onSort={clickSort} dim={loading} />}
    </div>
  );
}

function StatsBody({ stats, authors, sort, onSort, dim }: { stats: Stats; authors: AuthorStat[]; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; dim: boolean }) {
  const s = stats.summary;
  const cards: [string, string][] = [
    [t("stats.col.commits"), num.format(s.commits)],
    [t("stats.authors"), num.format(s.authors)],
    [t("stats.period"), s.first == null ? "—" : `${day(s.first)} ~ ${day(s.last)}`],
    [t("stats.branch"), t("stats.branchesVal", { b: s.branches, r: s.remoteBranches })],
    [t("stats.tags"), num.format(s.tags)],
    [t("stats.files"), num.format(s.files)],
    [t("stats.size"), size(s.sizeKb)],
  ];
  const maxWeek = Math.max(1, ...stats.weeks.map((w) => w.commits));
  const maxHeat = Math.max(1, ...stats.heatmap.flat());
  const ext = stats.extensions.slice(0, 10);
  const maxExt = Math.max(1, ...ext.map((e) => e.count));
  const W = Math.max(stats.weeks.length, 1);
  return (
    <div className="stats-body" style={{ opacity: dim ? 0.5 : 1 }}>
      <div className="stat-cards">
        {cards.map(([k, v]) => (
          <div key={k} className="stat-card">
            <span className="muted">{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <div className="stat-cols">
        <section>
          <h3>{t("stats.authors")}</h3>
          <table className="stat-table" aria-label={t("stats.authors")}>
            <thead>
              <tr>
                {COLS.filter(([k]) => stats.withLines || (k !== "added" && k !== "deleted")).map(([k, label]) => (
                  <th key={k} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button onClick={() => onSort(k)}>{t(label)}{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {authors.map((a) => (
                <tr key={a.email} title={a.email}>
                  <td>{a.name}</td>
                  <td className="n">{num.format(a.commits)}</td>
                  {stats.withLines && <td className="n">+{num.format(a.added)}</td>}
                  {stats.withLines && <td className="n">−{num.format(a.deleted)}</td>}
                  <td className="muted">{day(a.last)}</td>
                </tr>
              ))}
              {!authors.length && <tr><td className="muted" colSpan={5}>{t("stats.noCommits")}</td></tr>}
            </tbody>
          </table>
        </section>
        <section>
          <h3>{t("stats.extensions")}</h3>
          <ul className="ext-bars" aria-label={t("stats.extLabel")}>
            {ext.map((e) => (
              <li key={e.ext} title={t("stats.extCount", { n: e.count })}>
                <span className="ext-name">{e.ext ? `.${e.ext}` : t("stats.noExt")}</span>
                <span className="ext-bar"><i style={{ width: `${(e.count / maxExt) * 100}%` }} /></span>
                <span className="n">{num.format(e.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section>
        <h3>{t("stats.weekly")} {stats.weeks.length ? <span className="muted">{stats.weeks[0].start} ~ {stats.weeks.at(-1)!.start}</span> : null}</h3>
        <svg className="week-chart" role="img" aria-label={t("stats.weeklyLabel")} viewBox={`0 0 ${W * 10} 60`} preserveAspectRatio="none">
          {stats.weeks.map((w, i) => {
            const h = (w.commits / maxWeek) * 58;
            return (
              <rect key={w.start} x={i * 10 + 1} y={60 - h} width={8} height={h}>
                <title>{t("stats.weekTitle", { start: w.start, n: w.commits })}</title>
              </rect>
            );
          })}
        </svg>
      </section>
      <section>
        <h3>{t("stats.heat")} <span className="muted">{t("stats.heatNote")}</span></h3>
        <div className="heat" role="img" aria-label={t("stats.heatLabel")}>
          {stats.heatmap.map((row, d) => (
            <div key={d} className="heat-row">
              <span className="muted">{t(DAYS[d])}</span>
              {row.map((c, h) => (
                <i key={h} title={t("stats.heatTitle", { day: t(DAYS[d]), h, n: c })} style={{ "--v": `${Math.round((c / maxHeat) * 100)}%` } as React.CSSProperties} />
              ))}
            </div>
          ))}
          <div className="heat-row muted"><span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="heat-h">{h % 6 === 0 ? h : ""}</span>)}</div>
        </div>
      </section>
    </div>
  );
}
