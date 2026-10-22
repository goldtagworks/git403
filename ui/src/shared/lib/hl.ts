// diff 구문 강조. highlight.js 코어 + 필요한 언어만 (DiffView가 동적 import해서 첫 로드에 안 들어간다).
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import rust from "highlight.js/lib/languages/rust";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";

for (const [n, l] of Object.entries({ typescript, javascript, json, css, xml, rust, markdown, python, go, java, kotlin, swift, yaml, bash })) hljs.registerLanguage(n, l);

export type Tok = [cls: string, text: string];

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/** 여러 줄 코드를 강조하고 줄별 토큰 목록으로 돌려준다 (줄을 가로지르는 주석·문자열도 줄마다 이어서 칠한다). */
export function highlightLines(lang: string, code: string): Tok[][] {
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const lines: Tok[][] = [[]];
  const stack: string[] = [];
  for (const m of html.matchAll(/<span class="hljs-([^" ]*)[^"]*">|<\/span>|([^<]+)/g)) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[2] === undefined) stack.pop();
    else {
      const text = m[2].replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENT[e]);
      const cls = stack[stack.length - 1] ?? "";
      text.split("\n").forEach((part, i) => {
        if (i) lines.push([]);
        if (part) lines[lines.length - 1].push([cls, part]);
      });
    }
  }
  return lines;
}
