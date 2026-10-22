// 커밋 작성자 프로필 사진. 이메일→url 맵을 모듈 안에 두고 이메일별로 구독한다 (docs/performance.md).
// 맵이 바뀌어도 그 이메일의 <Avatar>와 Canvas 다시 그리기만 일어나고 CommitGraph·목록은 다시 렌더링되지 않는다.
import { memo, useState, useSyncExternalStore } from "react";
import { api } from "../api/api";
import type { Commit } from "../api/types";

const urls = new Map<string, string | null>(); // 소문자 이메일 → url (null = 사진 없음)
const asked = new Set<string>(); // 요청했거나 하는 중인 이메일
let owner = ""; // 맵이 속한 저장소 (원격이 저장소마다 달라서 바뀌면 비운다)
const subs = new Map<string, Set<() => void>>();
const anyChange = new Set<() => void>();
const key = (email: string) => email.trim().toLowerCase();

const emit = (emails: string[]) => {
  for (const e of emails) subs.get(e)?.forEach((f) => f());
  anyChange.forEach((f) => f());
};

/** 보이는 커밋들의 고유 이메일 중 아직 모르는 것만 한 번에 요청한다. */
export function requestAvatars(repo: string, commits: Commit[]) {
  if (owner !== repo) {
    owner = repo;
    urls.clear();
    asked.clear();
  }
  const items: { sha: string; email: string }[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    const e = key(c.email ?? "");
    if (!e || asked.has(e) || seen.has(e)) continue;
    seen.add(e);
    items.push({ sha: c.id, email: c.email });
  }
  if (!items.length) return;
  for (const e of seen) asked.add(e);
  api.authorAvatars(repo, items).then(
    (res) => {
      if (owner !== repo) return;
      const got = new Map(res.map((r) => [key(r.email), r.url]));
      for (const e of seen) urls.set(e, got.get(e) ?? null);
      emit([...seen]);
    },
    () => {
      if (owner !== repo) return;
      for (const e of seen) urls.set(e, null);
      emit([...seen]);
    },
  );
}

export const avatarUrl = (email: string) => urls.get(key(email)) ?? null;
/** Canvas용: 어느 이메일이든 맵이 바뀌면 부른다. 해제 함수를 돌려준다. */
export function onAvatarChange(f: () => void) {
  anyChange.add(f);
  return () => void anyChange.delete(f);
}

const useUrl = (email: string) =>
  useSyncExternalStore(
    (f) => {
      const k = key(email);
      const s = subs.get(k) ?? subs.set(k, new Set()).get(k)!;
      s.add(f);
      return () => void s.delete(f);
    },
    () => urls.get(key(email)) ?? null,
  );

// Canvas용 이미지 캐시. 불러오면 onLoad로 다시 그리게 한다. 실패는 "bad"로 기억해 이니셜(점)로 둔다.
const imgs = new Map<string, HTMLImageElement | "bad">();
export function avatarImage(url: string, onLoad: () => void): HTMLImageElement | null {
  const hit = imgs.get(url);
  if (hit) return hit === "bad" ? null : hit.complete && hit.naturalWidth ? hit : null;
  const img = new Image();
  imgs.set(url, img);
  img.onload = onLoad;
  img.onerror = () => imgs.set(url, "bad");
  img.src = url;
  return null;
}

export const hashIndex = (s: string, n: number) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % n;
};
export const initials = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  const first = (s: string) => [...s][0] ?? "";
  return (w.length > 1 ? first(w[0]) + first(w[1]) : first(w[0] ?? "?")).toUpperCase();
};

/** 동그란 작성자 사진. 사진이 없거나 못 불러오면 이니셜 + 이메일 해시 색. */
export const Avatar = memo(function Avatar({ name, email, size = 16 }: { name: string; email: string; size?: number }) {
  const url = useUrl(email);
  const [bad, setBad] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
  if (url && bad !== url)
    return <img className="avatar" style={style} src={url} alt="" draggable={false} onError={() => setBad(url)} />;
  return (
    <span className={`avatar av-${hashIndex(key(email) || name, 8)}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
});
