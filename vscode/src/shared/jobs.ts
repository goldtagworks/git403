// 패널(웹뷰)이 시작한 서버 작업 추적 (vscode 비의존). 서버는 확장 수명이라 패널을 닫아도 계속 살아 있으므로,
// 패널이 시작한 긴 작업·분리 작업·미답 인증 요청은 패널이 닫힐 때 직접 정리한다.
export class PanelWork {
  private jobs = new Set<number>();
  private detached = new Set<string>();
  private asks = new Set<number>();

  /** 웹뷰의 invoke가 성공했을 때 부른다 */
  track(cmd: string, args: Record<string, unknown> | undefined, result: unknown) {
    if ((cmd === "start_job" || cmd === "start_shell") && typeof result === "number") this.jobs.add(result);
    else if (cmd === "run_detached" && typeof args?.token === "string") this.detached.add(args.token);
    else if (cmd === "cancel_job") this.jobs.delete(Number(args?.job));
    else if (cmd === "cancel_detached") this.detached.delete(String(args?.token));
    else if (cmd === "askpass_reply") this.asks.delete(Number(args?.id));
  }

  /** 서버 이벤트. askpass는 웹뷰로 보낸 것만 센다 */
  event(event: string, payload: unknown, toPanel: boolean) {
    if (event === "job-done") this.jobs.delete(Number((payload as unknown[])[0]));
    else if (event === "detached-done") this.detached.delete(String((payload as unknown[])[0]));
    else if (event === "askpass" && toPanel) this.asks.add(Number((payload as { id: number }).id));
  }

  get pending() {
    return this.jobs.size + this.detached.size + this.asks.size;
  }

  /** 패널이 닫혔을 때: 진행 중 작업을 취소하고 미답 인증은 취소로 답한다 */
  async cleanup(request: (cmd: string, args: unknown) => Promise<unknown>) {
    const calls = [
      ...[...this.jobs].map((job) => request("cancel_job", { job })),
      ...[...this.detached].map((token) => request("cancel_detached", { token })),
      ...[...this.asks].map((id) => request("askpass_reply", { id, answer: null })),
    ];
    this.jobs.clear();
    this.detached.clear();
    this.asks.clear();
    await Promise.allSettled(calls);
  }
}
