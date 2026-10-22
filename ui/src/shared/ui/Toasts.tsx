import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { t as tr, useLocale } from "../i18n/i18n";
import type { IconName } from "./icons";
import { AUTO_MS, dismissToast, useToasts, type ToastItem, type ToastKind } from "../lib/toast";
import { countRender } from "../lib/profile";

const ICON: Record<ToastKind, IconName> = { success: "toastOk", info: "toastInfo", warning: "warning", error: "close" };

/** 한 장의 카드. 자동 사라짐 타이머와 마우스를 올리면 멈추는 동작을 여기서 자체 관리한다. */
const Card = memo(function Card({ t }: { t: ToastItem }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const hold = useRef(false); // 마우스·포커스가 카드 위에 있는지
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const left = useRef(AUTO_MS);
  const since = useRef(0);
  const auto = t.kind !== "error";

  const pause = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    left.current = Math.max(0, left.current - (Date.now() - since.current));
  };
  const resume = () => {
    if (!auto || hold.current || timer.current) return;
    since.current = Date.now();
    timer.current = setTimeout(() => dismissToast(t.id), left.current);
  };
  // 같은 알림이 다시 오면(rev) 시간을 처음부터 다시 잰다
  useEffect(() => {
    left.current = AUTO_MS;
    pause();
    resume();
    return pause;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.rev]);

  const holdOn = () => ((hold.current = true), pause());
  const holdOff = () => ((hold.current = false), resume());
  const long = t.kind === "error" && (!!t.detail || t.title.length > 70);

  return (
    <div
      className={`toast ${t.kind}${open ? " open" : ""}`}
      role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={holdOn}
      onMouseLeave={holdOff}
      onFocus={holdOn}
      onBlur={holdOff}
    >
      <span className="toast-icon"><Icon name={ICON[t.kind]} size={16} /></span>
      <div className="toast-body">
        <div className={`toast-title${t.kind === "error" ? " selectable" : ""}`} title={t.title}>
          {t.title}
          {t.n > 1 && <span className="toast-n">×{t.n}</span>}
        </div>
        {t.detail && <div className={`toast-detail${t.kind === "error" ? " selectable" : ""}`}>{t.detail}</div>}
        {long && (
          <button type="button" className="toast-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? tr("toast.less") : tr("toast.more")}
          </button>
        )}
      </div>
      <button type="button" className="toast-x" aria-label={tr("common.close")} onClick={() => dismissToast(t.id)}>
        <Icon name="dismiss" size={14} />
      </button>
    </div>
  );
});

/** 오른쪽 아래 토스트 스택. 스토어를 직접 구독하므로 토스트가 바뀌어도 이 컴포넌트만 다시 그려진다. */
export const Toasts = memo(function Toasts() {
  countRender("Toasts");
  useLocale();
  const items = useToasts();
  return <div className="toasts" aria-label={tr("toast.label")}>{items.map((t) => <Card key={t.id} t={t} />)}</div>;
});
