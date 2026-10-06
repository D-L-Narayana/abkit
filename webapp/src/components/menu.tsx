/**
 * Accessible menu button (WAI-ARIA "menu button" pattern), no runtime dependencies beyond React.
 *
 * - Trigger: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`; ArrowDown / ArrowUp open the menu and focus the
 *   first / last item; Enter and Space toggle it (native button activation).
 * - Menu: `role="menu"` of `role="menuitem"` buttons with a roving tabindex. ArrowDown / ArrowUp wrap, Home / End jump,
 *   a printable key jumps to the next item starting with that letter, Escape closes and returns focus to the trigger,
 *   Tab closes, a pointer-down outside closes. Selecting an item closes the menu, restores focus, then runs `onSelect`.
 * - Looks: only the `.menu*` classes from index.css, so it follows the active theme and prints nothing.
 */
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary text at the right edge, e.g. a file extension or a shortcut. */
  hint?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  /** Destructive styling (red text, red-soft hover). */
  danger?: boolean;
}
export interface MenuSeparator { id: string; separator: true }
export type MenuEntry = MenuItem | MenuSeparator;
export const isSeparator = (x: MenuEntry): x is MenuSeparator => "separator" in x && x.separator === true;

export interface MenuButtonProps {
  /** Trigger content (text and/or icon). */
  label: ReactNode;
  items: MenuEntry[];
  /** Which edge of the trigger the popup aligns to. */
  align?: "start" | "end";
  /** Accessible name when `label` is icon-only. */
  ariaLabel?: string;
  buttonClassName?: string;
  menuClassName?: string;
  className?: string;
  chevron?: boolean;
  disabled?: boolean;
}

export function MenuButton({ label, items, align = "end", ariaLabel, buttonClassName = "btn btn-ghost btn-sm", menuClassName = "", className = "", chevron = true, disabled = false }: MenuButtonProps) {
  const id = useId();
  const buttonId = `${id}-button`;
  const menuId = `${id}-menu`;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Preferred alignment, flipped when the popup would leave the viewport (e.g. a trigger near the left edge on a phone).
  const [side, setSide] = useState<"start" | "end">(align);
  useLayoutEffect(() => {
    if (!open) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = menuRef.current?.offsetWidth ?? 208;
    const fitsEnd = r.right - w >= 8;
    const fitsStart = r.left + w <= window.innerWidth - 8;
    setSide(align === "end" ? (fitsEnd || !fitsStart ? "end" : "start") : (fitsStart || !fitsEnd ? "start" : "end"));
  }, [open, align]);

  // Indexes (into `items`) that take focus: every non-separator entry. Disabled items stay focusable so screen-reader users discover them.
  const navigable = items.map((it, i) => (isSeparator(it) ? -1 : i)).filter((i) => i >= 0);
  const first = navigable[0] ?? -1;
  const last = navigable[navigable.length - 1] ?? -1;
  const focusIndex = active >= 0 ? active : first;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) buttonRef.current?.focus();
  }, []);
  const openAt = (index: number) => {
    setOpen(true);
    setActive(index);
  };

  // Outside pointer-down closes (capture phase so a click that re-renders the page still counts).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (!(ev.target instanceof Node) || !rootRef.current?.contains(ev.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  // Roving focus follows `active`.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  const move = (dir: 1 | -1) => {
    if (navigable.length === 0) return;
    const pos = navigable.indexOf(active);
    const next = pos < 0 ? (dir === 1 ? 0 : navigable.length - 1) : (pos + dir + navigable.length) % navigable.length;
    setActive(navigable[next]!);
  };
  const typeAhead = (key: string) => {
    const k = key.toLowerCase();
    const start = Math.max(0, navigable.indexOf(active) + 1);
    for (let step = 0; step < navigable.length; step++) {
      const idx = navigable[(start + step) % navigable.length]!;
      const it = items[idx];
      if (it && !isSeparator(it) && it.label.toLowerCase().startsWith(k)) {
        setActive(idx);
        return;
      }
    }
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        if (open) move(1); else if (!disabled) openAt(first);
        break;
      case "ArrowUp":
        ev.preventDefault();
        if (open) move(-1); else if (!disabled) openAt(last);
        break;
      case "Home":
        if (open) { ev.preventDefault(); setActive(first); }
        break;
      case "End":
        if (open) { ev.preventDefault(); setActive(last); }
        break;
      case "Escape":
        if (open) { ev.preventDefault(); ev.stopPropagation(); close(true); }
        break;
      case "Tab":
        if (open) close(false);
        break;
      default:
        if (open && ev.key.length === 1 && !ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key !== " ") {
          ev.preventDefault();
          typeAhead(ev.key);
        }
    }
  };
  const onToggle = (ev: MouseEvent<HTMLButtonElement>) => {
    if (open) close(false);
    // ev.detail === 0 → activated from the keyboard (Enter/Space): move focus into the menu as the ARIA pattern asks.
    else openAt(ev.detail === 0 ? first : -1);
  };
  const onBlur = (ev: FocusEvent<HTMLDivElement>) => {
    const next = ev.relatedTarget;
    if (open && next instanceof Node && !rootRef.current?.contains(next)) close(false);
  };

  return (
    <div ref={rootRef} className={`menu-wrap ${className}`} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onToggle}
      >
        {label}
        {chevron && <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && (
        <div ref={menuRef} role="menu" id={menuId} aria-labelledby={buttonId} aria-orientation="vertical" className={`menu ${menuClassName}`} data-align={side}>
          {items.map((it, i) =>
            isSeparator(it) ? (
              <div key={it.id} role="separator" className="menu-sep" />
            ) : (
              <button
                key={it.id}
                ref={(el) => { itemRefs.current[i] = el; }}
                type="button"
                role="menuitem"
                className={`menu-item ${it.danger ? "is-danger" : ""}`}
                tabIndex={i === focusIndex ? 0 : -1}
                aria-disabled={it.disabled ? true : undefined}
                onPointerMove={() => { if (active !== i) setActive(i); }}
                onClick={(ev) => {
                  if (it.disabled) { ev.preventDefault(); return; }
                  close(true);
                  void it.onSelect();
                }}
              >
                {it.icon && <span className="menu-icon" aria-hidden="true">{it.icon}</span>}
                <span>{it.label}</span>
                {it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
