// 다국어: 라이브러리 없이 최소 구조. 문구는 locales/en.ts(키 타입의 원본)와 언어별 locales/xx.ts(Record<Key,string>)에 있다.
// 언어 추가 = locales/xx.ts 한 파일 + settings.ts LOCALES·아래 DICTS·LANGS에 한 줄 + Rust SUPPORTED_LOCALES (키가 빠지면 빌드 실패).
// 이 파일은 settings.ts 외에는 아무것도 import하지 않는다 (api·ops가 t를 쓰므로 순환 방지).
import { useSyncExternalStore } from "react";
import { en, type Key } from "./locales/en";
import { ko } from "./locales/ko";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";
import { vi } from "./locales/vi";
import { ja } from "./locales/ja";
import { tl } from "./locales/tl";
import { km } from "./locales/km";
import { uz } from "./locales/uz";
import { lo } from "./locales/lo";
import { ru } from "./locales/ru";
import { th } from "./locales/th";
import { mn } from "./locales/mn";
import { ne } from "./locales/ne";
import { de } from "./locales/de";
import { fr } from "./locales/fr";
import { es } from "./locales/es";
import { ptBR } from "./locales/pt-BR";
import { it } from "./locales/it";
import { pl } from "./locales/pl";
import { tr } from "./locales/tr";
import { uk } from "./locales/uk";
import { nl } from "./locales/nl";
import { onPrefs, pref, type Locale } from "../lib/settings";

export type { Key, Locale };
const DICTS: Record<Locale, Record<Key, string>> = {
  en, ko, "zh-CN": zhCN, "zh-TW": zhTW, vi, ja, tl, km, uz, lo, ru, th, mn, ne, de, fr, es, "pt-BR": ptBR, it, pl, tr, uk, nl,
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

let current = resolve();
const subs = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = current;
// 설정이 바뀔 때마다 불리지만 언어가 그대로면 아무것도 안 한다 (리렌더링 없음)
onPrefs(() => {
  const next = resolve();
  if (next === current) return;
  current = next;
  document.documentElement.lang = next;
  subs.forEach((f) => f());
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
  const s = DICTS[current][key] ?? en[key];
  if (!vars) return s;
  return s
    .replace(/\{(\w+)\?([^:}]*):([^}]*)\}/g, (_, n: string, one: string, many: string) => (vars[n] === 1 ? one : many))
    .replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));
}

/** IPC 오류 코드 번역(`err.<code>`). 사전에 없는 코드면 Rust가 준 영어 원문 */
export const tErr = (code: string, vars: Vars | undefined, message: string) => (`err.${code}` in en ? t(`err.${code}` as Key, vars) : message);

const fmts = new Map<string, Intl.DateTimeFormat>();
/** 현재 언어의 날짜 포맷터 (언어·옵션별로 하나만 만든다) */
export const dateFmt = (opts: Intl.DateTimeFormatOptions) => {
  const k = intlTag() + JSON.stringify(opts);
  let f = fmts.get(k);
  if (!f) fmts.set(k, (f = new Intl.DateTimeFormat(intlTag(), opts)));
  return f;
};
