// 다국어: 라이브러리 없이 최소 구조. 문구는 locales/en.ts(키 타입의 원본)와 언어별 locales/xx.ts(Record<Key,string>)에 있다.
// 언어 추가 = locales/xx.ts 한 파일(첫 export가 사전) + settings.ts LOCALES·아래 LANGS에 한 줄 + Rust SUPPORTED_LOCALES (키가 빠지면 빌드 실패).
// 이 파일은 settings.ts·lib/safeText.ts(순수 함수, 의존 없음) 외에는 아무것도 import하지 않는다 (api·ops가 t를 쓰므로 순환 방지).
import { useSyncExternalStore } from "react";
import { en, type Key } from "./locales/en";
import { visibleText } from "../lib/safeText";
import { onPrefs, pref, type Locale } from "../lib/settings";

export type { Key, Locale };
type Dict = Record<Key, string>;
// en만 정적(키 타입 원본·폴백). 나머지는 쓰는 언어 파일 하나만 청크로 받는다 (각 파일은 `Record<Key,string>`을 첫 export로 내보낸다 — 타입은 파일 쪽에서 강제)
const loaders: Record<string, () => Promise<Record<string, Dict>>> = typeof document === "undefined" ? {} : import.meta.glob<Record<string, Dict>>(["./locales/*.ts", "!./locales/en.ts"]); // Node 테스트는 glob이 없다
const loaded: Partial<Record<Locale, Dict>> = { en };
/** 언어 사전을 받아 둔다 (이미 있으면 바로 끝). 못 받으면 영어로 남는다 */
const load = async (l: Locale) => {
  if (loaded[l]) return;
  try {
    loaded[l] = Object.values(await loaders[`./locales/${l}.ts`]())[0];
  } catch {}
};
/** 설정 창 선택지(각 언어 이름은 그 언어로) + Intl 로케일 태그. 순서는 settings.ts `LOCALES` */
export const LANGS: { id: Locale; name: string; tag: string }[] = [
  { id: "en", name: "English", tag: "en-US" }, { id: "ko", name: "한국어", tag: "ko-KR" },
  { id: "zh-CN", name: "简体中文", tag: "zh-CN" }, { id: "zh-TW", name: "繁體中文", tag: "zh-TW" },
  { id: "vi", name: "Tiếng Việt", tag: "vi-VN" }, { id: "ja", name: "日本語", tag: "ja-JP" },
  { id: "tl", name: "Filipino", tag: "fil-PH" }, { id: "km", name: "ខ្មែរ", tag: "km-KH" },
  { id: "uz", name: "O‘zbekcha", tag: "uz-UZ" }, { id: "lo", name: "ລາວ", tag: "lo-LA" },
  { id: "ru", name: "Русский", tag: "ru-RU" }, { id: "th", name: "ไทย", tag: "th-TH" },
  { id: "mn", name: "Монгол", tag: "mn-MN" }, { id: "ne", name: "नेपाली", tag: "ne-NP" },
  { id: "de", name: "Deutsch", tag: "de-DE" }, { id: "fr", name: "Français", tag: "fr-FR" },
  { id: "es", name: "Español", tag: "es-ES" }, { id: "pt-BR", name: "Português (Brasil)", tag: "pt-BR" },
  { id: "it", name: "Italiano", tag: "it-IT" }, { id: "pl", name: "Polski", tag: "pl-PL" },
  { id: "tr", name: "Türkçe", tag: "tr-TR" }, { id: "uk", name: "Українська", tag: "uk-UA" },
  { id: "nl", name: "Nederlands", tag: "nl-NL" },
];

/** 설정 `language`가 system이면: VS Code 웹뷰는 VS Code 표시 언어(`__git403.lang`, 미지원이면 en), 그 외 navigator.languages에서 처음 만나는 지원 언어, 없으면 en */
export const detect = (): Locale => {
  if (typeof navigator === "undefined") return "en"; // 테스트(Node)에서 순수 로직만 import할 때
  const host = (globalThis as unknown as { __git403?: { lang?: string } }).__git403?.lang;
  for (const l of host ? [host] : navigator.languages?.length ? navigator.languages : [navigator.language ?? ""]) {
    const normalized = l.toLowerCase();
    const p = normalized.split("-")[0];
    const id = p === "zh" ? (/tw|hk|mo|hant/.test(normalized) ? "zh-TW" : "zh-CN") : p === "pt" ? "pt-BR" : p === "fil" ? "tl" : p;
    const hit = LANGS.find((x) => x.id === id);
    if (hit) return hit.id;
  }
  return "en";
};
const resolve = (): Locale => {
  const p = pref("language");
  return p === "system" ? detect() : p;
};

let current: Locale = "en";
const subs = new Set<() => void>();
const apply = (next: Locale) => {
  current = next;
  document.documentElement.lang = next;
};
// 첫 렌더 전에 현재 언어를 받아 둔다(영어가 먼저 깜빡이지 않게 — 이 모듈을 쓰는 쪽은 로드가 끝난 뒤 실행된다). 테스트(Node)는 건너뜀
if (typeof document !== "undefined") {
  const first = resolve();
  await load(first);
  apply(loaded[first] ? first : "en");
}
// 설정이 바뀔 때마다 불리지만 언어가 그대로면 아무것도 안 한다 (리렌더링 없음). 바뀌면 사전을 받은 뒤 한 번에 갈아끼우고 알린다
onPrefs(() => {
  const next = resolve();
  if (next === current) return;
  void load(next).then(() => {
    if (resolve() !== next || next === current) return; // 기다리는 사이 또 바뀌었으면 마지막 것만
    apply(loaded[next] ? next : "en");
    subs.forEach((f) => f());
  });
});

export const locale = () => current;
/** 언어가 바뀔 때 알림 (useSyncExternalStore용). 구독 해제 함수를 돌려준다 */
export const onLocale = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** Intl 로케일 태그 (`ko-KR`·`en-US`) */
export const intlTag = () => LANGS.find((x) => x.id === current)!.tag;
/** 구독하면 언어가 바뀔 때만 다시 그려진다 (평소 리렌더링 없음). memo된 컴포넌트가 문구를 쓰면 호출한다. */
export const useLocale = () => useSyncExternalStore(onLocale, locale);

type Vars = Record<string, string | number>;
/**
 * 문구 조회. `{name}`은 vars로 치환, `{n?단수:복수}`는 vars.n === 1이면 앞, 아니면 뒤(한국어는 보통 복수형 하나만 쓴다).
 * 모듈 맨 위 상수에서 부르면 언어가 바뀌어도 안 바뀐다 — 함수 안에서 부를 것.
 */
export function t(key: Key, vars?: Vars): string {
  const s = loaded[current]![key] ?? en[key];
  if (!vars) return s;
  return s
    .replace(/\{(\w+)\?([^:}]*):([^}]*)\}/g, (_, n: string, one: string, many: string) => (vars[n] === 1 ? one : many))
    .replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));
}

/** IPC 오류 코드 번역(`err.<code>`). 사전에 없는 코드면 Rust가 준 영어 원문. 변수·원문에는 불신 문자열이 담길 수 있어 `visibleText`로 보이지 않는 문자를 가시화한다(여러 줄 폴백 message만 줄바꿈 유지) */
export const tErr = (code: string, vars: Vars | undefined, message: string) =>
  `err.${code}` in en ? t(`err.${code}` as Key, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? visibleText(v) : v]))) : visibleText(message, true);

const fmts = new Map<string, Intl.DateTimeFormat>();
/** 현재 언어의 날짜 포맷터 (언어·옵션별로 하나만 만든다) */
export const dateFmt = (opts: Intl.DateTimeFormatOptions) => {
  const k = intlTag() + JSON.stringify(opts);
  let f = fmts.get(k);
  if (!f) fmts.set(k, (f = new Intl.DateTimeFormat(intlTag(), opts)));
  return f;
};
