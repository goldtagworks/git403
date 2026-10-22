// ui/dist/index.html을 웹뷰용으로 바꾼다: 상대 경로 → webview URI, 인라인 스크립트에 nonce, CSP.
// vscode API 비의존(단위 테스트 가능): URI 변환은 호출 측이 함수로 준다.
export function webviewHtml(html: string, opts: { toUri: (rel: string) => string; cspSource: string; nonce: string; compact?: boolean; detail?: boolean; lang?: string; version?: string }): string {
  const { toUri, cspSource, nonce, compact, detail, lang, version } = opts;
  const out = html
    .replace(/\b(src|href)="\.\/([^"]+)"/g, (_m, attr, rel) => `${attr}="${toUri(rel)}"`)
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cspSource}`,
    // React가 style 속성을 쓰므로 인라인 스타일 허용
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    // 작성자 사진(https), 데이터 URI
    `img-src ${cspSource} https: data:`,
  ].join("; ");
  // compact(사이드바·아래 패널 뷰): 좁은 커밋 목록 모드, detail(편집기 영역 탭): 커밋 상세 + diff만 (bridge.ts COMPACT·DETAIL)
  // version: 확장 버전. 상태바가 앱 버전 대신 보이고 마켓플레이스 변경 내역으로 연결한다 (bridge.ts EXT_VERSION)
  // lang: VS Code 표시 언어(`vscode.env.language`). UI 언어가 system일 때 OS 언어 대신 이걸 따른다 (i18n.ts detect)
  const props = [compact ? "compact: true" : "", detail ? "detail: true" : "", lang ? `lang: ${JSON.stringify(lang)}` : "", version ? `version: ${JSON.stringify(version)}` : ""].filter(Boolean).join(", ");
  const mode = props ? `\n    <script nonce="${nonce}">window.__git403 = { ${props} };</script>` : "";
  return out.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />${mode}`);
}
