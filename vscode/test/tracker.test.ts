// 저장 전 편집 추적(라인 트래커) 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import { test } from "node:test";
import { LineTracker, Trackers, matchRun, type Change, type Reason } from "../src/services/tracker.ts";

/** 텍스트 편집기 흉내: 줄 배열에 변경을 적용하고, 같은 변경을 트래커에도 준다 */
class Doc {
  lines: string[];
  t: LineTracker;
  /** `track`: 디스크 줄 텍스트를 트래커에 줘서 재입력 매핑을 켠다 */
  constructor(text: string, track = false) {
    this.lines = text.split("\n");
    this.t = new LineTracker(this.lines.length, track ? [...this.lines] : undefined);
  }
  get text() {
    return this.lines.join("\n");
  }
  /** (l1,c1)~(l2,c2)를 text로 바꾼다 */
  edit(l1: number, c1: number, l2: number, c2: number, text: string, reason?: Reason) {
    this.editAll([{ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, text }], reason);
  }
  /** 여러 변경(모두 변경 전 문서 기준)을 한 이벤트로 */
  editAll(changes: Change[], reason?: Reason) {
    const off = (l: number, c: number) => this.lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0) + c;
    let s = this.text;
    for (const ch of [...changes].sort((a, b) => off(b.range.start.line, b.range.start.character) - off(a.range.start.line, a.range.start.character)))
      s = s.slice(0, off(ch.range.start.line, ch.range.start.character)) + ch.text + s.slice(off(ch.range.end.line, ch.range.end.character));
    this.lines = s.split("\n");
    this.t.apply(changes, reason);
  }
  /** 현재 줄 → 디스크 줄 전체 */
  get map() {
    return this.lines.map((_, i) => this.t.diskLine(i));
  }
}

test("처음에는 항등", () => {
  const d = new Doc("a\nb\nc");
  assert.deepEqual(d.map, [0, 1, 2]);
});

test("줄 삽입: 새 줄은 null, 아래 줄은 밀려도 원래 줄 유지", () => {
  const d = new Doc("a\nb\nc");
  d.edit(1, 0, 1, 0, "new\n"); // b 앞에 한 줄
  assert.deepEqual(d.lines, ["a", "new", "b", "c"]);
  assert.deepEqual(d.map, [0, null, 1, 2]);
  d.edit(3, 1, 3, 1, "\nend"); // 끝에 한 줄
  assert.deepEqual(d.map, [0, null, 1, 2, null]);
  d.edit(0, 1, 0, 1, "\nx\ny"); // 첫 줄 끝에서 줄 둘 추가
  assert.deepEqual(d.map, [0, null, null, null, 1, 2, null]);
});

test("줄 삭제: 사라지고 나머지는 유지", () => {
  const d = new Doc("a\nb\nc\nd");
  d.edit(1, 0, 2, 0, ""); // b 줄 통째로
  assert.deepEqual(d.lines, ["a", "c", "d"]);
  assert.deepEqual(d.map, [0, 2, 3]);
  d.edit(0, 0, 1, 0, ""); // a 줄
  assert.deepEqual(d.map, [2, 3]);
  d.edit(1, 0, 1, 1, ""); // d의 글자만 지움: 줄은 남는다
  assert.deepEqual(d.map, [2, 3]);
});

test("여러 줄 선택 삭제 후 한 줄이 남는 경우", () => {
  const d = new Doc("aaa\nbbb\nccc\nddd");
  d.edit(0, 1, 2, 1, ""); // "a" + "cc" → "acc"
  assert.deepEqual(d.lines, ["acc", "ddd"]);
  assert.deepEqual(d.map, [0, 3]);
  const e = new Doc("aaa\nbbb\nccc\nddd");
  e.edit(0, 0, 2, 2, ""); // 시작이 줄 첫 칸: 남은 "c"는 마지막 줄의 것
  assert.deepEqual(e.lines, ["c", "ddd"]);
  assert.deepEqual(e.map, [2, 3]);
});

test("줄 병합: 줄 끝 개행 삭제는 위 줄이 이어받고 아래 줄은 사라진다", () => {
  const d = new Doc("ab\ncd\nef");
  d.edit(0, 2, 1, 0, ""); // "abcd"
  assert.deepEqual(d.lines, ["abcd", "ef"]);
  assert.deepEqual(d.map, [0, 2]);
});

test("줄 분할: 끝에서 나누면 위가 유지, 처음에서 나누면 아래가 유지, 가운데는 위가 유지", () => {
  const end = new Doc("ab\ncd");
  end.edit(0, 2, 0, 2, "\n");
  assert.deepEqual(end.map, [0, null, 1]);
  const start = new Doc("ab\ncd");
  start.edit(1, 0, 1, 0, "\n");
  assert.deepEqual(start.map, [0, null, 1]);
  const mid = new Doc("abcd\nef");
  mid.edit(0, 2, 0, 2, "\n");
  assert.deepEqual(mid.lines, ["ab", "cd", "ef"]);
  assert.deepEqual(mid.map, [0, null, 1]);
});

test("여러 줄 붙여넣기: 줄 시작이면 기존 줄이 마지막에 이어진다", () => {
  const d = new Doc("a\nb");
  d.edit(1, 0, 1, 0, "x\ny\nz\n"); // b 앞에 세 줄
  assert.deepEqual(d.lines, ["a", "x", "y", "z", "b"]);
  assert.deepEqual(d.map, [0, null, null, null, 1]);
  const e = new Doc("a\nb");
  e.edit(0, 1, 0, 1, "1\n2\n3"); // 줄 중간에 여러 줄 → "a1","2","3"+""
  assert.deepEqual(e.lines, ["a1", "2", "3", "b"]);
  assert.deepEqual(e.map, [0, null, null, 1]);
});

test("바꿔치기: 여러 줄을 여러 줄로", () => {
  const d = new Doc("a\nb\nc\nd\ne");
  d.edit(1, 0, 3, 1, "X\nY"); // b..d 를 두 줄로
  assert.deepEqual(d.lines, ["a", "X", "Y", "e"]);
  assert.deepEqual(d.map, [0, null, 3, 4]); // 시작이 줄 첫 칸이라 마지막 조각이 d의 자리를 이어받는다
});

test("한 이벤트의 여러 변경(멀티 커서): 순서와 무관하게 변경 전 기준으로 적용", () => {
  const mk = () => new Doc("a\nb\nc\nd");
  const ch = (l: number, text: string): Change => ({ range: { start: { line: l, character: 0 }, end: { line: l, character: 0 } }, text });
  const down = mk();
  down.editAll([ch(3, "x\n"), ch(1, "y\n")]);
  const up = mk();
  up.editAll([ch(1, "y\n"), ch(3, "x\n")]);
  assert.deepEqual(down.lines, ["a", "y", "b", "c", "x", "d"]);
  assert.deepEqual(down.map, [0, null, 1, 2, null, 3]);
  assert.deepEqual(up.map, down.map);
});

test("undo: 삽입을 되돌리면(역변경) 원래 매핑으로, 글자 편집은 매핑을 건드리지 않는다", () => {
  const d = new Doc("a\nb\nc");
  d.edit(1, 0, 1, 0, "new\n");
  d.edit(1, 0, 2, 0, ""); // undo: 삽입한 줄 제거
  assert.deepEqual(d.lines, ["a", "b", "c"]);
  assert.deepEqual(d.map, [0, 1, 2]);
  d.edit(0, 1, 0, 1, "xyz");
  assert.deepEqual(d.map, [0, 1, 2]);
  d.edit(0, 1, 0, 4, "");
  assert.deepEqual(d.map, [0, 1, 2]);
  // 분할 후 병합(undo)
  d.edit(1, 0, 1, 0, "\n");
  d.edit(1, 0, 2, 0, "");
  assert.deepEqual(d.map, [0, 1, 2]);
});

test("문서 끝 빈 줄(끝 개행)과 범위 밖 편집에도 던지지 않는다", () => {
  const d = new Doc("a\nb\n"); // 줄 3개(마지막은 빈 줄)
  d.edit(2, 0, 2, 0, "c\nd");
  assert.deepEqual(d.lines, ["a", "b", "c", "d"]);
  assert.equal(d.t.diskLine(10), null);
  const t = new LineTracker(1);
  t.apply([{ range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, text: "x\n" }]);
  assert.equal(t.diskLine(0), 0);
});

test("CRLF·CR 개행도 줄로 센다", () => {
  const t = new LineTracker(2);
  t.apply([{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "\r\nx\r\ny" }]);
  assert.deepEqual([0, 1, 2, 3].map((i) => t.diskLine(i)), [0, null, null, 1]);
});

test("범위 변환: 디스크에 있던 줄만, 없으면 null", () => {
  const d = new Doc("a\nb\nc\nd\ne");
  d.edit(2, 0, 2, 0, "n1\nn2\n"); // a b n1 n2 c d e
  assert.deepEqual(d.t.diskRange(0, 1), { start: 0, end: 1 });
  assert.deepEqual(d.t.diskRange(1, 4), { start: 1, end: 2 }); // 새 줄은 건너뜀
  assert.equal(d.t.diskRange(2, 3), null); // 새 줄만 선택
  assert.deepEqual(d.t.diskRange(0, 6), { start: 0, end: 4 });
});

test("reset과 Trackers: 깨끗해지면 처음 상태, 처음 본 변경도 따라간다", () => {
  const ts = new Trackers();
  const ins: Change = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "x\n" };
  // 변경 이벤트가 처음 보는 문서: 변경 후 줄 수 4에서 변경 전 3줄을 거꾸로 계산
  ts.change("f", 4, true, [ins]);
  assert.deepEqual([0, 1, 2, 3].map((i) => ts.get("f", 4).diskLine(i)), [0, null, 1, 2]);
  ts.change("f", 3, false, []); // 저장·되돌리기로 깨끗
  assert.deepEqual([0, 1, 2].map((i) => ts.get("f", 3).diskLine(i)), [0, 1, 2]);
  ts.delete("f");
  assert.equal(ts.size, 0);
});

// ---- 무작위 검증 ----
let seed = 12345;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);

test("무작위 줄 단위 편집: 정확한 오라클과 일치한다", () => {
  for (let round = 0; round < 200; round++) {
    const n = 1 + rnd(8);
    const d = new Doc(Array.from({ length: n }, (_, i) => `L${i}`).join("\n"));
    const oracle: (number | null)[] = d.lines.map((_, i) => i);
    for (let step = 0; step < 12; step++) {
      const len = d.lines.length;
      if (rnd(2) === 0) {
        // 줄 k 앞에 j줄 삽입 (줄 시작에서)
        const k = rnd(len + 1) % len, j = 1 + rnd(3);
        d.edit(k, 0, k, 0, "n\n".repeat(j));
        oracle.splice(k, 0, ...Array(j).fill(null));
      } else if (len > 1) {
        // 줄 k부터 j줄 통째로 삭제 (마지막 줄이 아닌 구간)
        const k = rnd(len - 1), j = 1 + rnd(len - 1 - k);
        d.edit(k, 0, k + j, 0, "");
        oracle.splice(k, j);
      }
      assert.deepEqual(d.map, oracle, `round ${round} step ${step}`);
    }
  }
});

test("무작위 임의 편집: 줄 수가 항상 맞고 디스크 줄은 단조 증가", () => {
  for (let round = 0; round < 300; round++) {
    const d = new Doc(Array.from({ length: 1 + rnd(10) }, (_, i) => "x".repeat(i)).join("\n"));
    for (let step = 0; step < 15; step++) {
      const l1 = rnd(d.lines.length), c1 = rnd(d.lines[l1].length + 1);
      const l2 = Math.min(d.lines.length - 1, l1 + rnd(3)), c2 = l2 === l1 ? c1 + rnd(d.lines[l1].length - c1 + 1) : rnd(d.lines[l2].length + 1);
      d.edit(l1, c1, l2, c2, ["", "a", "\n", "a\nb", "\n\n", "q\n"][rnd(6)]);
      assert.equal(d.t.lineCount, d.lines.length, `round ${round} step ${step}`);
      const seen = d.map.filter((x): x is number => x !== null);
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "단조 증가");
      assert.equal(new Set(seen).size, seen.length, "디스크 줄은 한 번만");
    }
  }
});

test("문서 전체를 바꾸는 변경(되돌리기·다시 읽기)은 대응을 새로 시작하고, 줄 수가 어긋나면 읽을 때 바로잡는다", () => {
  const ts = new Trackers();
  const ins: Change = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "x\n" };
  ts.change("f", 4, true, [ins]); // 3줄 → 4줄
  assert.equal(ts.get("f", 4).diskLine(0), null);
  // 되돌리기: 전체 교체(0,0 ~ 끝)가 아직 dirty 표시인 채 와도 처음 상태
  const whole: Change = { range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }, text: "a\nb\nc" };
  ts.change("f", 3, true, [whole]);
  assert.deepEqual([0, 1, 2].map((i) => ts.get("f", 3).diskLine(i)), [0, 1, 2]);
  // 줄 수가 어긋난 트래커는 읽을 때 항등으로
  ts.change("g", 3, true, [ins]);
  assert.deepEqual([0, 1, 2].map((i) => ts.sync("g", 2 + 1).diskLine(i)), [null, 0, 1]);
  assert.deepEqual([0, 1].map((i) => ts.sync("g", 2).diskLine(i)), [0, 1]);
});

test("삭제 후 undo(reason): 삭제한 줄이 원래 디스크 줄로 복원, redo는 다시 삭제", () => {
  const d = new Doc("a\nb\nc\nd");
  d.edit(1, 0, 3, 0, ""); // b,c 삭제
  assert.deepEqual(d.map, [0, 3]);
  d.edit(1, 0, 1, 0, "b\nc\n", "undo");
  assert.deepEqual(d.lines, ["a", "b", "c", "d"]);
  assert.deepEqual(d.map, [0, 1, 2, 3], "undo는 원래 blame 유지");
  d.edit(1, 0, 3, 0, "", "redo");
  assert.deepEqual(d.map, [0, 3]);
  d.edit(1, 0, 1, 0, "b\nc\n", "undo");
  assert.deepEqual(d.map, [0, 1, 2, 3]);
});

test("디스크 텍스트가 없으면(이미 고친 채 열린 문서) reason 없는 같은 삽입은 새 줄(커밋 안 됨)로 본다", () => {
  const d = new Doc("a\nb\nc");
  d.edit(1, 0, 2, 0, "");
  d.edit(1, 0, 1, 0, "b\n");
  assert.deepEqual(d.map, [0, null, 2]);
});

test("여러 단계 undo/redo: 글자 편집·삽입·삭제가 섞여도 단계마다 복원", () => {
  const d = new Doc("a\nb\nc\nd\ne");
  const snaps = [d.map];
  d.edit(0, 1, 0, 1, "x"); snaps.push(d.map); // 글자
  d.edit(1, 0, 3, 0, ""); snaps.push(d.map); // b,c 삭제
  d.edit(1, 0, 1, 0, "n\n"); snaps.push(d.map); // 삽입
  d.edit(0, 0, 1, 0, ""); snaps.push(d.map); // 첫 줄 삭제
  assert.deepEqual(d.map, [null, 3, 4]);
  d.edit(0, 0, 0, 0, "ax\n", "undo");
  assert.deepEqual(d.map, snaps[3]);
  d.edit(1, 0, 2, 0, "", "undo");
  assert.deepEqual(d.map, snaps[2]);
  d.edit(1, 0, 1, 0, "b\nc\n", "undo");
  assert.deepEqual(d.map, snaps[1]);
  d.edit(0, 1, 0, 2, "", "undo");
  assert.deepEqual(d.map, snaps[0]);
  d.edit(0, 1, 0, 1, "x", "redo");
  d.edit(1, 0, 3, 0, "", "redo");
  assert.deepEqual(d.map, snaps[2]);
  d.edit(1, 0, 1, 0, "n\n", "redo");
  assert.deepEqual(d.map, snaps[3]);
  // 새 편집은 redo를 버린다
  d.edit(2, 0, 2, 0, "z\n");
  d.edit(0, 0, 0, 0, "", "redo"); // 남은 redo 없음: 던지지 않고 변경만 따라간다
});

test("전체 교체 후 undo는 교체 전 대응으로, 저장(reset)하면 스택을 버린다", () => {
  const ts = new Trackers();
  const del: Change = { range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } }, text: "" };
  ts.change("f", 4, true, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "" }]);
  ts.change("f", 2, true, [del]); // 4줄 → 2줄
  assert.deepEqual([0, 1].map((i) => ts.get("f", 2).diskLine(i)), [0, 3]);
  const whole: Change = { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }, text: "p\nq\nr" };
  ts.change("f", 3, true, [whole]); // 전체 붙여넣기
  ts.change("f", 2, true, [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, text: "a\nd" }], "undo");
  assert.deepEqual([0, 1].map((i) => ts.get("f", 2).diskLine(i)), [0, 3]);
  ts.reset("f", 2);
  ts.change("f", 3, true, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "x\n" }], "undo"); // 스택 없음
  assert.equal(ts.get("f", 3).lineCount, 3);
});

test("무작위 편집+undo/redo: 오라클과 일치한다", () => {
  for (let round = 0; round < 200; round++) {
    const n = 2 + rnd(8);
    const d = new Doc(Array.from({ length: n }, (_, i) => `L${i}`).join("\n"));
    type Step = { fwd: [number, number, number, number, string]; inv: [number, number, number, number, string]; before: (number | null)[]; after: (number | null)[] };
    const done: Step[] = [], undone: Step[] = [];
    for (let step = 0; step < 20; step++) {
      const r = rnd(4);
      if (r === 2 && done.length) {
        const s = done.pop()!;
        d.edit(...s.inv, "undo");
        undone.push(s);
        assert.deepEqual(d.map, s.before, `round ${round} step ${step} undo`);
      } else if (r === 3 && undone.length) {
        const s = undone.pop()!;
        d.edit(...s.fwd, "redo");
        done.push(s);
        assert.deepEqual(d.map, s.after, `round ${round} step ${step} redo`);
      } else {
        const len = d.lines.length, before = d.map;
        let fwd: Step["fwd"], inv: Step["inv"];
        if (r === 0 || len < 2) {
          const k = rnd(len), j = 1 + rnd(3);
          fwd = [k, 0, k, 0, "n\n".repeat(j)];
          inv = [k, 0, k + j, 0, ""];
        } else {
          const k = rnd(len - 1), j = 1 + rnd(len - 1 - k);
          fwd = [k, 0, k + j, 0, ""];
          inv = [k, 0, k, 0, d.lines.slice(k, k + j).join("\n") + "\n"];
        }
        d.edit(...fwd);
        done.push({ fwd, inv, before, after: d.map });
        undone.length = 0;
      }
    }
  }
});

// ---- 재입력 매핑(삭제한 줄과 같은 내용을 붙여넣기·다시 입력) ----
test("재입력: 잘라내기 → 같은 자리 붙여넣기는 원래 blame", () => {
  const d = new Doc("a\nb\nc\nd", true);
  d.edit(1, 0, 2, 0, ""); // b 잘라내기
  assert.deepEqual(d.map, [0, 2, 3]);
  d.edit(1, 0, 1, 0, "b\n"); // 같은 자리 붙여넣기
  assert.deepEqual(d.map, [0, 1, 2, 3]);
  // 여러 줄 블록, 마지막 줄·문서 끝
  d.edit(1, 0, 3, 0, ""); // b,c 삭제
  assert.deepEqual(d.map, [0, 3]);
  d.edit(1, 0, 1, 0, "b\nc\n");
  assert.deepEqual(d.map, [0, 1, 2, 3]);
  const e = new Doc("a\nb\nc", true);
  e.edit(0, 1, 2, 1, ""); // "a" + "" → 첫 줄만 남음
  e.edit(0, 1, 0, 1, "\nb\nc");
  assert.deepEqual(e.map, [0, 1, 2]);
});

test("재입력: 일부만 같으면 같은 줄만, 고쳐 붙인 줄은 새 줄", () => {
  const d = new Doc("a\nb\nc\nd\ne", true);
  d.edit(1, 0, 4, 0, ""); // b,c,d 삭제
  d.edit(1, 0, 1, 0, "b\nC!\nd\n");
  assert.deepEqual(d.map, [0, 1, null, 3, 4]);
  // 앞에 새 줄을 끼워 붙여도 같은 줄은 찾는다
  const e = new Doc("a\nb\nc\nd", true);
  e.edit(1, 0, 3, 0, "");
  e.edit(1, 0, 1, 0, "new\nb\nc\n");
  assert.deepEqual(e.map, [0, null, 1, 2, 3]);
});

test("재입력: 글자를 다시 타이핑해도(빈 줄을 만들고 한 글자씩) 원래 줄로 돌아온다", () => {
  const d = new Doc("a\nbb\nc", true);
  d.edit(1, 0, 2, 0, ""); // bb 줄 삭제
  d.edit(1, 0, 1, 0, "\n"); // 빈 줄(새 줄)
  assert.equal(d.map[1], null, "빈 줄은 오매칭하지 않는다");
  d.edit(1, 0, 1, 0, "b");
  assert.equal(d.map[1], null, "b는 디스크 줄이 아니다");
  d.edit(1, 1, 1, 1, "b");
  assert.deepEqual(d.map, [0, 1, 2]);
});

test("재입력 정책: 다른 위치로 옮긴 줄은 새 줄(순서를 해치는 매핑 금지)", () => {
  const d = new Doc("a\nb\nc\nd", true);
  d.edit(1, 0, 2, 0, ""); // b 잘라내기
  d.edit(2, 0, 2, 0, "b\n"); // a c b d
  assert.deepEqual(d.lines, ["a", "c", "b", "d"]);
  assert.deepEqual(d.map, [0, 2, null, 3]);
  // 위로 옮기기도 마찬가지
  const e = new Doc("a\nb\nc\nd", true);
  e.edit(2, 1, 3, 1, ""); // 마지막 줄 d 삭제(앞 개행째)
  e.edit(0, 0, 0, 0, "d\n");
  assert.deepEqual(e.map, [null, 0, 1, 2]);
});

test("재입력: 빈 줄·공백 줄은 이웃 사이 구간이 똑같을 때만", () => {
  // 새로 끼운 빈 줄: 이웃 사이에 비어 있는 디스크 줄이 없다
  const a = new Doc("a\n\nb", true);
  a.edit(1, 0, 1, 0, "\n");
  assert.deepEqual(a.map, [0, null, 1, 2]);
  // 지운 빈 줄을 그 자리에 다시: 원래 줄
  const b = new Doc("a\n\nb", true);
  b.edit(1, 0, 2, 0, "");
  b.edit(1, 0, 1, 0, "\n");
  assert.deepEqual(b.map, [0, 1, 2]);
  // 지운 줄이 빈 줄이 아닌데 빈 줄을 넣으면 새 줄
  const c = new Doc("a\nb\n\nc", true);
  c.edit(1, 0, 3, 0, ""); // b와 빈 줄 삭제
  c.edit(1, 0, 1, 0, "\n\n");
  assert.deepEqual(c.map, [0, null, null, 3]);
  // 공백만 있는 줄은 내용까지 같아야 한다
  const e = new Doc("a\n  \nb", true);
  e.edit(1, 0, 2, 0, "");
  e.edit(1, 0, 1, 0, "\t\n");
  assert.deepEqual(e.map, [0, null, 2]);
  e.edit(1, 0, 2, 0, "");
  e.edit(1, 0, 1, 0, "  \n");
  assert.deepEqual(e.map, [0, 1, 2]);
  // 흔한 줄("}")도 이웃 사이에 지워진 줄이 없으면 새 줄
  const f = new Doc("f1\n}\nf2\n}", true);
  f.edit(1, 0, 1, 0, "}\n"); // 앞에 하나 더
  assert.deepEqual(f.map, [0, null, 1, 2, 3]);
});

test("재입력: undo/redo는 그대로 스택이 복원하고, 재입력 뒤 undo도 문제없다", () => {
  const d = new Doc("a\nb\nc", true);
  d.edit(1, 0, 2, 0, "");
  d.edit(1, 0, 1, 0, "b\n"); // 재입력: [0,1,2]
  assert.deepEqual(d.map, [0, 1, 2]);
  d.edit(1, 0, 2, 0, "", "undo"); // 붙여넣기 undo → 삭제 상태
  assert.deepEqual(d.map, [0, 2]);
  d.edit(1, 0, 1, 0, "b\n", "undo"); // 삭제 undo
  assert.deepEqual(d.map, [0, 1, 2]);
});

test("재입력: Trackers — 저장·열기 때의 줄 텍스트로 시작, 모르면(이미 고친 문서) 끈다", () => {
  const ts = new Trackers();
  const ch = (l1: number, l2: number, text: string): Change => ({ range: { start: { line: l1, character: 0 }, end: { line: l2, character: 0 } }, text });
  ts.get("f", 3, () => ["a", "b", "c"]);
  ts.change("f", 2, true, [ch(1, 2, "")]);
  ts.change("f", 3, true, [ch(1, 1, "b\n")]);
  assert.deepEqual([0, 1, 2].map((i) => ts.get("f", 3).diskLine(i)), [0, 1, 2]);
  // 저장하면 새 기준
  ts.change("f", 3, false, [], undefined, () => ["a", "x", "c"]);
  ts.change("f", 2, true, [ch(1, 2, "")]);
  ts.change("f", 3, true, [ch(1, 1, "b\n")]); // 디스크의 줄은 x였다
  assert.deepEqual([0, 1, 2].map((i) => ts.get("f", 3).diskLine(i)), [0, null, 2]);
  ts.change("f", 3, true, [ch(1, 2, "x\n")]); // b 줄을 x로 바꿔 쓴다(전체 줄 교체)
  assert.equal(ts.get("f", 3).diskLine(1), 1);
  // 텍스트를 모르는 트래커
  ts.get("g", 3);
  ts.change("g", 2, true, [ch(1, 2, "")]);
  ts.change("g", 3, true, [ch(1, 1, "b\n")]);
  assert.deepEqual([0, 1, 2].map((i) => ts.get("g", 3).diskLine(i)), [0, null, 2]);
});

test("재입력 무작위: 같은 자리 되붙이기는 항상 복원, 다른 자리는 항상 새 줄, 임의 편집에서도 불변식 유지", () => {
  for (let round = 0; round < 300; round++) {
    const n = 3 + rnd(10);
    const d = new Doc(Array.from({ length: n }, (_, i) => `L${i}`).join("\n"), true);
    const k = rnd(n - 1), j = 1 + rnd(n - 1 - k); // 마지막 줄을 뺀 구간
    const block = d.lines.slice(k, k + j).join("\n") + "\n";
    d.edit(k, 0, k + j, 0, "");
    const rest = d.lines.length; // 마지막 줄까지 포함한 줄 수
    const at = rnd(rest);
    d.edit(at, 0, at, 0, block);
    if (at === k) assert.deepEqual(d.map, Array.from({ length: n }, (_, i) => i), `round ${round} 같은 자리`);
    else assert.ok(d.map.slice(at, at + j).every((x) => x === null), `round ${round} 다른 자리 ${JSON.stringify(d.map)}`);
  }
  for (let round = 0; round < 300; round++) {
    const n = 2 + rnd(10);
    const disk = Array.from({ length: n }, (_, i) => (i % 4 === 3 ? "" : `L${i % 5}`)); // 빈 줄·중복 내용 섞기
    const d = new Doc(disk.join("\n"), true);
    for (let step = 0; step < 15; step++) {
      const l1 = rnd(d.lines.length), c1 = rnd(d.lines[l1].length + 1);
      const l2 = Math.min(d.lines.length - 1, l1 + rnd(3)), c2 = l2 === l1 ? c1 + rnd(d.lines[l1].length - c1 + 1) : rnd(d.lines[l2].length + 1);
      d.edit(l1, c1, l2, c2, ["", "L1", "\n", "L0\nL1", "\n\n", "L2\n", "\nL3"][rnd(7)]);
      assert.equal(d.t.lineCount, d.lines.length);
      const seen = d.map.filter((x): x is number => x !== null);
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `단조 증가 ${round}/${step}`);
      assert.equal(new Set(seen).size, seen.length, "디스크 줄은 한 번만");
    }
  }
});

test("matchRun: 성능 — 큰 구간도 상한 안에서 끝난다", () => {
  const n = 20000;
  const disk = Array.from({ length: n }, (_, i) => `line ${i}`);
  const t0 = Date.now();
  // 거의 같은 큰 블록(앞뒤 일치분은 선형, 가운데만 LCS)
  const cur = disk.slice();
  cur[n / 2] = "changed";
  const pairs = matchRun(cur, 0, n, disk, 0, n);
  assert.equal(pairs.length, n - 1);
  // 전혀 다른 큰 구간은 표 상한으로 건너뛴다
  assert.equal(matchRun(disk.map((s) => s + "!"), 0, n, disk, 0, n).length, 0);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
});
