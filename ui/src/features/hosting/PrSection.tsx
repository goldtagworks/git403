import { memo, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { Icon } from "../../shared/ui/Icon";
import { contextMenu } from "../../shared/ui/menu";
import { ctx, ops, prBus, store, stored } from "../../shared/model/ops";
import { t, useLocale } from "../../shared/i18n/i18n";
import { countRender } from "../../shared/lib/profile";
import type { Pr, RemoteInfo } from "../../shared/api/types";

interface Item extends Pr { remote: string }
/** Rust가 한 번에 가져오는 개수(crates/hosting `page_limit`). 이만큼 받으면 더 있을 수 있다고 본다 */
const LIMIT = { github: 100, gitlab: 100, gitea: 50, bitbucket: 50 };
const LIST_PATH = { github: "pulls", gitlab: "-/merge_requests", gitea: "pulls", bitbucket: "pull-requests" };

/**
 * 사이드바 Pull Requests 섹션. 계정이 연결된 원격, 또는 계정 없이 gh 로그인으로 조회되는 GitHub 원격이 있을 때만 보인다.
 * 저장소를 열 때와 `prBus` 신호(Fetch 완료·계정 변경·수동 새로고침) 때 한 번 조회한다.
 * 조회 결과는 이 컴포넌트 상태에만 있어 그래프·사이드바 나머지는 다시 그려지지 않는다. 실패는 조용히 무시한다.
 */
export const PrSection = memo(function PrSection({ repo }: { repo: string }) {
  countRender("PrSection");
  useLocale();
  const [infos, setInfos] = useState<RemoteInfo[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState<string[]>([]); // 상한까지 받은 원격의 웹 목록 URL
  const [open, setOpen] = useState(() => stored("prOpen", true));
  const seq = useRef(0);

  useEffect(() => {
    // 탭을 빨리 바꾸면 늦게 온 이전 저장소의 결과는 버린다 (seq)
    const load = async () => {
      const mine = ++seq.current;
      const all = (await api.remoteInfo(repo).catch(() => [] as RemoteInfo[])).filter((i) => i.account || i.provider === "github");
      if (mine !== seq.current) return;
      // 계정 없는 GitHub 원격은 gh 로그인 토큰으로 조회한다(pr_inbox). 실패(gh 없음·미로그인)면 그 원격은 뺀다
      const lists = await Promise.all(
        all.map((i) =>
          (i.account ? api.prList(i.account, i.repo, ctx.repo || undefined) : api.prInbox(null, i.repo, null, "open", false, ctx.repo || undefined)).then(
            (l) => l.map((p) => ({ number: p.number, title: p.title, url: p.url, head: p.head, base: p.base, author: p.author, remote: i.remote })),
            () => (i.account ? ([] as Item[]) : null),
          ),
        ),
      );
      if (mine !== seq.current) return;
      const found = all.filter((_, k) => lists[k]);
      setInfos((p) => (p.length || found.length ? found : p));
      setItems(lists.flatMap((l) => l ?? []));
      setMore(found.filter((i) => (lists[all.indexOf(i)] ?? []).length >= LIMIT[i.provider!]).map((i) => `${i.webUrl.replace(/\/+$/, "")}/${LIST_PATH[i.provider!]}`));
    };
    setInfos((p) => (p.length ? [] : p));
    setItems((p) => (p.length ? [] : p));
    setMore((p) => (p.length ? [] : p));
    load();
    const off = prBus.on(load);
    return () => {
      seq.current++;
      off();
    };
  }, [repo]);

  if (!infos.length) return null;
  return (
    <section>
      <button
        className="section-title"
        aria-expanded={open}
        onClick={() => setOpen((o) => (store("prOpen", !o), !o))}
        onContextMenu={contextMenu(() => [{ label: t("pr.refresh"), action: ops.prRefresh }, { label: t("pr.create"), action: () => ops.createPr() }])}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        Pull Requests
        <span className="count">{items.length}</span>
      </button>
      {open &&
        items.map((p) => (
          <button
            key={`${p.remote}#${p.number}`}
            className="item"
            style={{ paddingLeft: 12 }}
            title={`#${p.number} ${p.title}\n${p.head} → ${p.base} · ${p.author}`}
            onClick={() => ops.prReview(p.number)}
            onContextMenu={contextMenu(() => [
              { label: t("prr.title"), action: () => ops.prReview(p.number) },
              { label: t("pr.openBrowser"), action: () => ops.openUrl(p.url) },
              { label: t("pr.checkout", { head: p.head }), action: () => ops.checkoutPr(p.remote, p.head) },
              { separator: true },
              { label: t("pr.copyUrl"), action: () => ops.copy(p.url) },
            ])}
          >
            <Icon name="pull" />
            <span className="label">#{p.number} {p.title}</span>
          </button>
        ))}
      {open &&
        more.map((url) => (
          <button key={url} className="item" style={{ paddingLeft: 12 }} title={url} onClick={() => ops.openUrl(url)}>
            <span className="label hint">{t("pr.more")}</span>
          </button>
        ))}
    </section>
  );
});
