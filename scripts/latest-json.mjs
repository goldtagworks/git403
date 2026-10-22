// 업데이터 매니페스트(latest.json)에 플랫폼 하나를 넣는다. Mac·Windows 배포 스크립트가 같이 쓴다.
// node scripts/latest-json.mjs <latest.json> <version> <platform> <url> <sig 파일>
import fs from "node:fs";
const [file, version, platform, url, sigFile] = process.argv.slice(2);
let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const platforms = cur.version === version ? cur.platforms ?? {} : {}; // 버전이 바뀌면 예전 플랫폼은 버린다
platforms[platform] = { signature: fs.readFileSync(sigFile, "utf8").trim(), url };
fs.writeFileSync(file, JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2));
