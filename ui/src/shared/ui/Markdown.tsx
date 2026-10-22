import { memo, useMemo, type CSSProperties, type MouseEvent } from "react";
import MarkdownIt from "markdown-it";
import { ops } from "../model/ops";
import { prSha } from "../model/prsha";

// html: false → 본문 속 HTML은 글자로 보인다(sanitizer 불필요). javascript: 등 위험한 링크는 markdown-it 기본 validateLink가 막는다
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// 이미지는 인증이 필요한 첨부가 많아 불러오지 않고 링크로만 보인다
md.renderer.rules.image = (tokens, i) => {
  const tk = tokens[i];
  const src = md.utils.escapeHtml(tk.attrGet("src") ?? "");
  return `<a href="${src}">🖼 ${md.utils.escapeHtml(tk.content || src)}</a>`;
};

// 커밋 sha 링크(26 후속): GitHub가 만든 `/commit/<sha>`(·`/pull/N/commits/<sha>`) 링크와 맨 sha 글자(7~40자 hex, 숫자·a-f가 모두 있는 것)에 data-sha를 단다.
// 코드·이미 링크 안의 글자는 건드리지 않는다. 클릭·호버는 아래 핸들러가 prSha(PR 화면이 등록)로 넘긴다.
const SHA_HREF = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:pull\/\d+\/)?commits?\/([0-9a-f]{7,40})(?:[/?#].*)?$/;
const SHA_TEXT = /(?<![0-9A-Za-z_-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z_-])/g;
md.core.ruler.push("sha", (state) => {
  for (const blk of state.tokens) {
    if (blk.type !== "inline" || !blk.children) continue;
    const out: typeof blk.children = [];
    let depth = 0;
    for (const tk of blk.children) {
      if (tk.type === "link_open") {
        depth++;
        const m = SHA_HREF.exec(tk.attrGet("href") ?? "");
        if (m) (tk.attrSet("data-sha", m[1]), tk.attrJoin("class", "md-sha"));
      } else if (tk.type === "link_close") depth--;
      if (tk.type !== "text" || depth || !tk.content) {
        out.push(tk);
        continue;
      }
      let at = 0;
      for (const m of tk.content.matchAll(SHA_TEXT)) {
        const text = (s: string) => Object.assign(new state.Token("text", "", 0), { content: s });
        if (m.index! > at) out.push(text(tk.content.slice(at, m.index)));
        const a = new state.Token("link_open", "a", 1);
        a.attrs = [["href", "#"], ["data-sha", m[0]], ["class", "md-sha"]];
        out.push(a, text(m[0]), new state.Token("link_close", "a", -1));
        at = m.index! + m[0].length;
      }
      if (at === 0) out.push(tk);
      else if (at < tk.content.length) out.push(Object.assign(new state.Token("text", "", 0), { content: tk.content.slice(at) }));
    }
    blk.children = out;
  }
});

/** 링크는 앱 안에서 이동하지 않고 브라우저로 연다 */
const onClick = (e: MouseEvent) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  const web = href && /^https?:\/\//i.test(href) ? href : null;
  const sha = a.dataset.sha;
  if (sha && prSha.handler) return prSha.handler.click(sha, web); // PR 화면 안에서는 sha 링크를 앱 안에서 연다(PR 커밋·그래프·브라우저 순)
  if (web) ops.openUrl(web);
};
const shaOf = (e: { target: EventTarget }) => (e.target as HTMLElement).closest?.<HTMLElement>("a[data-sha]") ?? null;
const hover = (e: React.SyntheticEvent) => {
  const a = shaOf(e);
  if (a) prSha.hover(a.dataset.sha!, a);
};
const leave = (e: React.SyntheticEvent) => shaOf(e) && prSha.leave();

/** 마크다운 뷰어(PR 본문·리뷰·코멘트). GFM 표·코드 블록·링크, 이미지는 링크로. `md-clamp`면 `lines`(줄 수) 높이까지만 보인다 */
export const Markdown = memo(function Markdown({ text, className, lines }: { text: string; className?: string; lines?: number }) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className={`md selectable${className ? " " + className : ""}`}
      style={lines ? ({ "--md-lines": lines } as CSSProperties) : undefined}
      onClick={onClick}
      onMouseOver={hover}
      onMouseOut={leave}
      onFocus={hover}
      onBlur={leave}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/** 마크다운을 서식 없는 한 덩어리 글자로(제목·굵게·목록 기호·코드 표시 제거, 블록 사이는 공백) */
const plain = (text: string) =>
  (new DOMParser().parseFromString(md.render(text).replace(/<\/(p|h[1-6]|li|tr|pre|blockquote)>/g, " "), "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim();

/** 목록·타임라인용 미리보기: 서식 없이 일반 글자 크기·muted 색으로 `lines`줄까지. 서식은 팝업에서만 보인다 */
export const MdPreview = memo(function MdPreview({ text, lines }: { text: string; lines: number }) {
  const s = useMemo(() => plain(text), [text]);
  return <p className="md-prev" style={{ "--md-lines": lines } as CSSProperties}>{s}</p>;
});
