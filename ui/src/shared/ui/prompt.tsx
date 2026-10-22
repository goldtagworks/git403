import { useEffect, useRef, useState } from "react";
import { Sheet, SheetActions, SheetBody, SheetHead } from "./Sheet";
import { api } from "../api/api";
import { t, useLocale } from "../i18n/i18n";

export type Field =
  | { kind: "text" | "password" | "folder"; name: string; label: string; value?: string; placeholder?: string; optional?: boolean }
  | { kind: "check"; name: string; label: string; value?: boolean }
  | { kind: "select"; name: string; label: string; value?: string; options: string[] };

export interface PromptSpec {
  title: string;
  message?: string;
  fields: Field[];
  submit: string;
  /** 위험 작업이면 주 버튼이 danger 색. 함수면 입력값에 따라(예: force 체크) */
  danger?: boolean | ((v: Record<string, string | boolean>) => boolean);
  /** 값이 바뀔 때 다른 값을 맞춘다 (예: URL → 이름 추정) */
  change?: (next: Values, prev: Values) => Values;
}

type Values = Record<string, string | boolean>;

let open: ((spec: PromptSpec, resolve: (v: Values | null) => void) => void) | null = null;

/**
 * 입력이 필요한 작업용 시트 (브랜치 이름, 태그, 스태시 메시지, 옵션 등).
 * 단순 확인은 OS 대화상자(`ask`)를 쓴다 (docs/design.md). 취소하면 null.
 */
export const prompt = (spec: PromptSpec) => new Promise<Values | null>((resolve) => open?.(spec, resolve));

export function PromptHost() {
  useLocale();
  const [state, setState] = useState<{ spec: PromptSpec; resolve: (v: Values | null) => void } | null>(null);
  const [values, setValues] = useState<Values>({});
  const dlg = useRef<HTMLElement | null>(null);

  useEffect(() => {
    open = (spec, resolve) => {
      setValues(Object.fromEntries(spec.fields.map((f) => [f.name, f.value ?? (f.kind === "check" ? false : f.kind === "select" ? f.options[0] : "")])));
      setState({ spec, resolve });
    };
  }, []);
  // 첫 포커스: 첫 입력칸(없으면 선택 상자·체크). 그래야 열자마자 타이핑·Enter로 끝낼 수 있다
  useEffect(() => void dlg.current?.querySelector<HTMLElement>("input:not([type=checkbox]), select, input")?.focus(), [state]);

  if (!state) return null;
  const done = (v: Values | null) => {
    state.resolve(v);
    setState(null);
  };
  const set = (name: string, v: string | boolean) => setValues((prev) => (state.spec.change ?? ((n) => n))({ ...prev, [name]: v }, prev));
  const missing = state.spec.fields.some((f) => f.kind !== "check" && f.kind !== "select" && !("optional" in f && f.optional) && !String(values[f.name] ?? "").trim());

  return (
    <Sheet
      label={state.spec.title}
      onClose={() => done(null)}
      dialogRef={dlg}
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) done(values);
      }}
    >
      <SheetHead title={state.spec.title} />
      <SheetBody>
        {state.spec.message && <p>{state.spec.message}</p>}
        {state.spec.fields.map((f) => (
          <label key={f.name} className={"field " + f.kind}>
            {f.kind === "check" ? (
              <>
                <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}
              </>
            ) : (
              <>
                <span>{f.label}</span>
                {f.kind === "folder" ? (
                  <span className="folder-field">
                    <input value={String(values[f.name] ?? "")} spellCheck={false} aria-label={f.label} onChange={(e) => set(f.name, e.target.value)} />
                    <button type="button" onClick={async () => { const p = await api.pickFolder(f.label); if (p) set(f.name, p); }}>{t("prompt.choose")}</button>
                  </span>
                ) : f.kind !== "select" ? (
                  <input
                    type={f.kind}
                    value={String(values[f.name] ?? "")}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                ) : (
                  <select value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)}>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                )}
              </>
            )}
          </label>
        ))}
      </SheetBody>
      <SheetActions onCancel={() => done(null)} primary={state.spec.submit} danger={typeof state.spec.danger === "function" ? state.spec.danger(values) : state.spec.danger} disabled={missing} reason={t("sheet.needFields")} />
    </Sheet>
  );
}
