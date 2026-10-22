// 다중 저장소 (vscode 비의존: 단위 테스트 가능): 작업 영역 폴더(멀티루트·하위 폴더)에서 저장소 찾기, 저장소별 감시 동기화.
import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscoverOpts {
  /** 작업 영역 폴더에서 몇 단계 아래까지 찾을지 (기본 3) */
  maxDepth?: number;
  maxRepos?: number;
  /** 읽는 폴더 수 상한(큰 모노레포에서 오래 걸리지 않게) */
  maxDirs?: number;
}

const SKIP = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "__pycache__"]);

/** 폴더에서 위로 올라가며 처음 만나는 저장소 루트(`.git` 폴더·파일). 폴더 자체가 저장소거나 없으면 null */
export async function parentRepo(dir: string, fsp: Pick<typeof fs.promises, "stat"> = fs.promises): Promise<string | null> {
  const isRepo = (d: string) => fsp.stat(path.join(d, ".git")).then(() => true, () => false);
  if (await isRepo(dir)) return null;
  for (let d = path.dirname(dir); ; d = path.dirname(d)) {
    if (await isRepo(d)) return d;
    if (d === path.dirname(d)) return null;
  }
}

/** 작업 영역 폴더 `root` 아래의 `.git` 경로가 저장소 탐색 깊이(기본 3) 안인가: 저장소는 root에서 maxDepth단계, `.git`은 한 단계 더 */
export function gitInDepth(root: string, gitPath: string, maxDepth = 3): boolean {
  const rel = path.relative(root, gitPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length <= maxDepth + 1 && parts[parts.length - 1] === ".git" && !parts.slice(0, -1).some((p) => p.startsWith(".") || SKIP.has(p));
}

/**
 * 작업 영역 폴더들에서 git 저장소를 찾는다: 폴더 자체와 그 하위의 `.git`(폴더·파일 — worktree·서브모듈 포함).
 * 폴더가 저장소의 하위 폴더이면 그 상위 저장소도 포함한다(파일 경로는 그 저장소 기준 상대 경로가 된다).
 * 저장소 안으로도 내려가며(서브모듈·따로 clone한 하위 저장소), 점으로 시작하는 폴더·node_modules 등·심볼릭 링크는 건너뛴다. 결과는 정렬·중복 제거.
 */
export async function discoverRepos(roots: readonly string[], o: DiscoverOpts = {}, fsp: Pick<typeof fs.promises, "stat" | "readdir"> = fs.promises): Promise<string[]> {
  const { maxDepth = 3, maxRepos = 50, maxDirs = 2000 } = o;
  const found = new Set<string>();
  let dirs = 0;
  const isRepo = (d: string) => fsp.stat(path.join(d, ".git")).then(() => true, () => false);
  for (const root of roots) {
    const up = await parentRepo(root, fsp);
    if (up) found.add(up);
    const queue: [string, number][] = [[root, 0]];
    while (queue.length && found.size < maxRepos && dirs < maxDirs) {
      const [dir, depth] = queue.shift()!;
      dirs++;
      if (await isRepo(dir)) found.add(dir); // 저장소 안의 하위 저장소(서브모듈·따로 clone한 것)도 찾는다
      if (depth >= maxDepth) continue;
      let ents: { name: string; isDirectory(): boolean }[] = [];
      try {
        ents = (await fsp.readdir(dir, { withFileTypes: true })) as typeof ents;
      } catch {
        continue;
      }
      // Dirent.isDirectory()는 심볼릭 링크를 따라가지 않으므로 링크는 자연히 빠진다
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return [...found].sort();
}

type Request = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 저장소별 감시: 목록이 바뀌면 새 저장소는 `watch_add`, 빠진 저장소는 `watch_remove`. 같은 저장소를 두 번 추가하지 않는다 */
export class RepoWatch {
  private watched = new Set<string>();
  private req: Request;
  constructor(req: Request) {
    this.req = req;
  }

  private want: readonly string[] = [];
  private chain: Promise<void> = Promise.resolve();

  /**
   * 목록을 맞춘다. 호출은 직렬 큐로 돌아(겹치지 않음) 실행 시점의 **가장 최근 목록**을 기준으로 add/remove 한다 — 빠른 add→remove→add가 서버에 엇갈려 닿지 않는다.
   * 실패한 저장소는 다음 sync에서 다시 시도한다
   */
  sync(repos: readonly string[]): Promise<void> {
    this.want = [...repos];
    const run = this.chain.then(() => this.apply());
    this.chain = run.catch(() => {});
    return run;
  }

  private async apply(): Promise<void> {
    const repos = this.want;
    const want = new Set(repos);
    await Promise.all([
      ...repos.filter((r) => !this.watched.has(r)).map(async (r) => {
        this.watched.add(r);
        await this.req("watch_add", { repo: r }).catch(() => this.watched.delete(r));
      }),
      ...[...this.watched].filter((r) => !want.has(r)).map(async (r) => {
        this.watched.delete(r);
        await this.req("watch_remove", { repo: r }).catch(() => {});
      }),
    ]);
  }

  /** 서버가 다시 떴을 때(감시가 사라짐) */
  forget() {
    this.watched.clear();
  }

  get repos() {
    return [...this.watched].sort();
  }
}

const realCache = new Map<string, string>();
const realpath = (p: string) => {
  let r = realCache.get(p);
  if (r === undefined) {
    try {
      r = fs.realpathSync.native(p);
    } catch {
      r = p; // 아직 없는 경로는 그대로(캐시하지 않는다)
      return r;
    }
    if (realCache.size > 500) realCache.clear();
    realCache.set(p, r);
  }
  return r;
};

/** 저장소 경로 비교 키: 심볼릭 링크 해석(realpath)·끝 구분자 제거·Windows/macOS는 대소문자 무시 */
export function repoKey(p: string, platform: NodeJS.Platform = process.platform, real: (p: string) => string = realpath): string {
  let k = path.resolve(real(path.resolve(p)));
  if (k.length > 1 && /[\\/]$/.test(k) && path.parse(k).root !== k) k = k.slice(0, -1);
  return platform === "win32" || platform === "darwin" ? k.toLowerCase() : k;
}

/** 같은 변경을 두 번 알리는 이벤트(웹뷰 UI의 `watch_repo`와 확장의 `watch_add`가 같은 저장소를 볼 때)를 짧은 시간 안에서 한 번으로 합친다. 저장소는 정규화한 경로(`repoKey`)로 비교한다 */
export class EventDedupe {
  private last = new Map<string, number>();
  private win: number;
  private key: (p: string) => string;
  constructor(windowMs = 150, key: (p: string) => string = repoKey) {
    this.win = windowMs;
    this.key = key;
  }
  /** 처음 보는 이벤트면 true */
  fresh(repo: string, worktree: boolean, refs: boolean, now = Date.now()): boolean {
    const k = `${this.key(repo)}\0${worktree}\0${refs}`;
    const prev = this.last.get(k);
    this.last.set(k, now);
    return prev === undefined || now - prev > this.win;
  }
}

export const sameRepo = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && repoKey(a) === repoKey(b);
