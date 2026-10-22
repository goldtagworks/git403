// CHANGELOG.md에서 버전 절을 뽑아 릴리스 노트로 출력한다. 절이 없으면 기본 문구.
// node scripts/release-notes.mjs <version>
import { readFileSync } from "node:fs";

const v = process.argv[2];
const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const m = md.match(new RegExp(`^## ${v.replaceAll(".", "\\.")}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
console.log(m ? m[1].trim() : "코드 서명 없는 개인용 빌드입니다. 설치·업데이트: README 참고");
