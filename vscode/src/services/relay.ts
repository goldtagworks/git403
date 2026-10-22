// git403-server(stdio, 줄 단위 JSON) 중계. vscode API에 의존하지 않아 Node 단위 테스트가 가능하다.
// 프로토콜: docs/reuse.md "stdio 서버 git403-server".
import { spawn, type ChildProcess } from "node:child_process";

export type ServerEvent = { event: string; payload: unknown };

export interface RelayOptions {
  /** 서버 실행 파일 경로 */
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (e: ServerEvent) => void;
  /** 진단(stderr 등) */
  onLog?: (line: string) => void;
  /** 서버가 (dispose 말고) 끝났을 때. 다음 요청에서 다시 뜨므로 서버 쪽 상태(감시 등)를 다시 만들어야 한다 */
  onExit?: () => void;
}

export class Relay {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  private disposed = false;
  private opts: RelayOptions;

  constructor(opts: RelayOptions) {
    this.opts = opts;
  }

  get running() {
    return this.child !== null;
  }

  /** 서버가 없으면 띄운다 (죽었으면 다음 요청 때 다시) */
  start() {
    if (this.child || this.disposed) return;
    const child = spawn(this.opts.command, this.opts.args ?? [], { cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.handle(line);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => this.opts.onLog?.(s.trimEnd()));
    child.stdin!.on("error", () => {});
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p.err(new Error(why));
      this.pending.clear();
      if (!this.disposed) this.opts.onExit?.();
    };
    child.on("error", (e) => gone(`git403-server: ${e.message}`));
    child.on("exit", (code, sig) => gone(`git403-server exited (${sig ?? code})`));
  }

  private handle(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      this.opts.onLog?.(`invalid server line: ${line}`);
      return;
    }
    if (typeof m.event === "string") return this.opts.onEvent({ event: m.event, payload: m.payload });
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if ("err" in m) p.err(new Error(String(m.err)));
    else p.ok(m.ok);
  }

  request(cmd: string, args?: unknown): Promise<unknown> {
    this.start();
    const child = this.child;
    if (!child) return Promise.reject(new Error("git403-server is not running"));
    const id = ++this.seq;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      child.stdin!.write(JSON.stringify({ id, cmd, args: args ?? {} }) + "\n", (e) => {
        if (e) {
          this.pending.delete(id);
          err(e);
        }
      });
    });
  }

  /** stdin을 닫아 서버가 작업·감시를 정리하고 끝나게 한다. 안 끝나면 잠시 뒤 kill */
  dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((done) => {
      const t = setTimeout(() => (child.kill(), done()), 3000);
      child.once("exit", () => (clearTimeout(t), done()));
      child.stdin!.end();
    });
  }
}
