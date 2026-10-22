import { icons, type IconName } from "./icons";

/** Solar 아이콘. 색은 글자색(currentColor)을 따른다. */
export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: icons[name] }}
    />
  );
}
