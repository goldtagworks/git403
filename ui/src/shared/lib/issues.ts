// 이슈 트래커 링크: 규칙(정규식 → URL 템플릿)로 커밋 메시지의 이슈 번호를 링크로 바꾼다. 순수 로직(IPC 없음).
import type { RemoteInfo } from "../api/types";

export interface IssueRule {
  /** git config `git403.issue.<id>.*`의 id. 자동 규칙은 "auto" */
  id: string;
  regex: string;
  /** 템플릿: `$1`…`$9`(캡처 그룹), `$&`(전체 일치). 치환 값은 URL 인코딩된다 */
  url: string;
}
export interface Compiled { re: RegExp; url: string }
export type Piece = string | { text: string; url: string };

const KEY = /^git403\.issue\.([^.\s]+)\.(regex|url)$/;
/** `config --get-regexp ^git403\.issue\.` 출력 → 규칙 (regex·url 둘 다 있는 것만, id 순) */
export function parseRules(out: string): IssueRule[] {
  const m = new Map<string, Partial<IssueRule>>();
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    const k = KEY.exec(i < 0 ? line : line.slice(0, i));
    if (!k) continue;
    const r = m.get(k[1]) ?? { id: k[1] };
    r[k[2] as "regex" | "url"] = i < 0 ? "" : line.slice(i + 1);
    m.set(k[1], r);
  }
  return [...m.values()].filter((r) => r.regex && r.url).sort((a, b) => a.id!.localeCompare(b.id!, undefined, { numeric: true })) as IssueRule[];
}

/** GitHub·GitLab 원격이면 `#123` 기본 규칙. 원격이 여럿이면 origin 우선 */
export function autoRule(infos: RemoteInfo[]): IssueRule | null {
  const i = [...infos].sort((a, b) => Number(b.remote === "origin") - Number(a.remote === "origin")).find((x) => x.provider === "github" || x.provider === "gitlab");
  return i ? { id: "auto", regex: "#(\\d+)", url: `${i.webUrl.replace(/\/+$/, "")}${i.provider === "gitlab" ? "/-" : ""}/issues/$1` } : null;
}

/** 잘못된 정규식은 건너뛴다 */
export const compile = (rules: IssueRule[]): Compiled[] =>
  rules.flatMap((r) => {
    try {
      return [{ re: new RegExp(r.regex, "g"), url: r.url }];
    } catch {
      return [];
    }
  });

/** 텍스트를 일반 글자와 링크 조각으로 나눈다. 겹치면 앞 규칙·먼저 나온 것이 이기고, http(s) 링크만 만든다 */
export function linkify(text: string, rules: Compiled[]): Piece[] {
  const hits: { start: number; end: number; url: string; rank: number }[] = [];
  rules.forEach(({ re, url }, rank) => {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null, n = 0; n < 50 && (m = re.exec(text)); n++) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      const href = url.replace(/\$(\d|&)/g, (_, k) => encodeURIComponent(k === "&" ? m![0] : m![+k] ?? ""));
      if (/^https?:\/\//i.test(href)) hits.push({ start: m.index, end: m.index + m[0].length, url: href, rank });
    }
  });
  hits.sort((a, b) => a.start - b.start || a.rank - b.rank);
  const out: Piece[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    if (h.start > at) out.push(text.slice(at, h.start));
    out.push({ text: text.slice(h.start, h.end), url: h.url });
    at = h.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out.length ? out : [text];
}

// ---- Jira: 주소 + 프로젝트 키 → 규칙 한 개. 기본값은 없다(사용자마다 Jira가 다르다) ----
export interface Jira { url: string; keys: string }
/** 주소 검증·정리: https://만, 끝 `/` 제거, 공백·쿼리·#는 거부. 빈 값은 "" */
export function cleanJiraUrl(s: string): string | null {
  const v = s.trim().replace(/\/+$/, "");
  if (!v) return "";
  return /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v) ? v : null;
}
/** 프로젝트 키(쉼표 구분) 검증·정리: 대문자 `[A-Z][A-Z0-9]+`만, 중복 제거. 빈 값은 "" (모든 KEY-123) */
export function cleanJiraKeys(s: string): string | null {
  const list = s.split(",").map((k) => k.trim()).filter(Boolean);
  if (list.some((k) => !/^[A-Z][A-Z0-9]+$/.test(k))) return null;
  return [...new Set(list)].join(",");
}
/** Jira 주소가 있을 때만 규칙을 만든다 (id "jira") */
export function jiraRule(j: Jira | null): IssueRule | null {
  if (!j?.url) return null;
  const keys = j.keys.split(",").filter(Boolean);
  return { id: "jira", regex: keys.length ? `\\b(${keys.join("|")})-\\d+\\b` : "\\b[A-Z][A-Z0-9]+-\\d+\\b", url: `${j.url}/browse/$&` };
}
export interface JiraCfg { url?: string; keys?: string; off?: boolean }
/** `git403.jira.*` 설정(소문자 키)에서 읽기 */
export const jiraCfg = (c: Record<string, string>): JiraCfg => ({ url: c["git403.jira.url"], keys: c["git403.jira.keys"], off: /^(true|1|yes|on)$/i.test(c["git403.jira.off"] ?? "") });
/** 전역 + 저장소 설정을 합친 실제 값. 저장소 값이 있으면 덮어쓰고, off면 null */
export function jiraEffective(g: JiraCfg, l: JiraCfg): Jira | null {
  if (l.off) return null;
  const url = cleanJiraUrl(l.url ?? g.url ?? "");
  if (!url) return null;
  return { url, keys: cleanJiraKeys(l.keys ?? g.keys ?? "") ?? "" };
}

export interface JiraSuggestion { url: string; keys: string[] }
const NOT_KEYS = new Set(["UTF", "SHA", "MD", "CVE", "ISO", "RFC", "CRC", "AES", "RSA", "TLS", "X", "WIP"]);
const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const top = (m: Map<string, number>, min: number) => [...m].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([k]) => k);
/** 커밋 로그·문서·브랜치 이름에서 Jira 주소·키 후보를 찾는다 (순수). 주소는 https만, 키는 2회 이상 나온 상위 3개 */
export function jiraSuggest(log: string, docs: string[], branches: string[]): JiraSuggestion | null {
  const urls = new Map<string, number>();
  for (const text of [log, ...docs]) {
    for (const m of text.matchAll(/https:\/\/[^\s/]+(?:\/[^\s]*)?\/browse\/[A-Z][A-Z0-9]+-\d+/g)) count(urls, m[0].slice(0, m[0].lastIndexOf("/browse/")));
    for (const m of text.matchAll(/https:\/\/[A-Za-z0-9-]+\.atlassian\.net\b/g)) count(urls, m[0]);
  }
  const keys = new Map<string, number>();
  for (const text of [log, ...branches]) for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g)) if (!NOT_KEYS.has(m[1])) count(keys, m[1]);
  const url = top(urls, 1).map((u) => cleanJiraUrl(u)).find(Boolean) ?? "";
  const ks = top(keys, 2).slice(0, 3);
  return url || ks.length ? { url, keys: ks } : null;
}
