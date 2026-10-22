// 확장자 → highlight.js 언어. hl.ts(무거움)와 분리해 첫 로드 번들에 가볍게 둔다.
const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", scss: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  rs: "rust", md: "markdown", py: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", zsh: "bash",
};

export const langOf = (path: string) => EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
