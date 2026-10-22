import type { ChangedFile } from "../api/types";

export type FileRow =
  | { kind: "dir"; name: string; depth: number }
  | { kind: "file"; name: string; depth: number; file: ChangedFile };

interface Dir {
  dirs: Map<string, Dir>;
  files: ChangedFile[];
}

/**
 * 변경 파일을 폴더 트리 행으로 편다. 자식이 폴더 하나뿐인 폴더는
 * `src/ui/components`처럼 한 줄로 합친다 (VS Code와 같은 방식).
 */
export function toTree(files: ChangedFile[]): FileRow[] {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }

  const rows: FileRow[] = [];
  const walk = (d: Dir, depth: number) => {
    for (const [name, child] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let c = child;
      while (c.files.length === 0 && c.dirs.size === 1) {
        const [[n, next]] = c.dirs;
        label += "/" + n;
        c = next;
      }
      rows.push({ kind: "dir", name: label, depth });
      walk(c, depth + 1);
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path)))
      rows.push({ kind: "file", name: f.path.split("/").pop()!, depth, file: f });
  };
  walk(root, 0);
  return rows;
}
