import { intlTag } from "../i18n/i18n";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
const fmts = new Map<string, Intl.RelativeTimeFormat>();

/** "3일 전" 같은 상대 시간 (언어는 앱 언어). time = 초 단위 UNIX 시간 */
export function relTime(time: number): string {
  const tag = intlTag();
  let f = fmts.get(tag);
  if (!f) fmts.set(tag, (f = new Intl.RelativeTimeFormat(tag, { numeric: "auto", style: "short" })));
  const d = time - Date.now() / 1000;
  for (const [u, s] of UNITS) if (Math.abs(d) >= s) return f.format(Math.round(d / s), u);
  return f.format(Math.round(d / 60) || 0, "minute");
}
