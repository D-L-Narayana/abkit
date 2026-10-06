/**
 * Small, accessible filter controls used by list pages (Dashboard).
 * Theme-aware through the existing tokens/classes only (.btn, .chip, .input, .label, bg-bg2, border-line …).
 */
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search, X } from "lucide-react";
import { useId, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentOption<T extends string> { value: T; label: ReactNode; count?: number }

/**
 * Exclusive choice rendered as a WAI-ARIA radio group: one tab stop (roving tabindex), arrow keys / Home / End move
 * the selection, the selected option carries aria-checked="true".
 */
export function SegmentedControl<T extends string>({ label, value, options, onChange, className = "" }: { label: string; value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; className?: string }) {
  const id = useId();
  const selected = options.findIndex((o) => o.value === value);
  const focusable = selected >= 0 ? selected : 0;
  function onKeyDown(ev: KeyboardEvent<HTMLDivElement>) {
    let next = -1;
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (focusable + 1) % options.length;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (focusable - 1 + options.length) % options.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = options.length - 1;
    const opt = next >= 0 ? options[next] : undefined;
    if (!opt) return;
    ev.preventDefault();
    onChange(opt.value);
    ev.currentTarget.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus();
  }
  return (
    <div role="radiogroup" aria-labelledby={id} className={`inline-flex flex-wrap items-center gap-0.5 p-0.5 rounded-xl bg-bg2 border border-line ${className}`} onKeyDown={onKeyDown}>
      <span id={id} className="sr-only">{label}</span>
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === focusable ? 0 : -1}
            data-index={i}
            className={`btn btn-sm h-8 px-2.5 text-[0.8rem] gap-1.5 ${on ? "btn-soft font-semibold" : "btn-ghost border-transparent"}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
            {o.count !== undefined && <span className="mono text-[11px] font-normal">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Labelled search box with a clear button; the label is visually hidden but announced. */
export function SearchInput({ label, value, onChange, placeholder, className = "" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const id = useId();
  return (
    <div className={`relative min-w-0 ${className}`}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <Search size={15} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 faint pointer-events-none" />
      <input
        id={id}
        type="search"
        className="input pl-9 pr-9 appearance-none [&::-webkit-search-cancel-button]:appearance-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {value !== "" && (
        <button type="button" className="btn btn-ghost btn-icon border-transparent absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange("")}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export interface SortOption<T extends string> { value: T; label: string }
export type SortDir = "asc" | "desc";

/** Labelled sort-key select with an optional direction toggle. */
export function SortSelect<T extends string>({ label = "Sort by", value, options, onChange, dir, onDirChange, className = "" }: { label?: string; value: T; options: SortOption<T>[]; onChange: (v: T) => void; dir?: SortDir; onDirChange?: (d: SortDir) => void; className?: string }) {
  const id = useId();
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <label htmlFor={id} className="label mb-0 whitespace-nowrap">{label}</label>
      <select
        id={id}
        className="input h-9 w-auto text-sm"
        value={value}
        onChange={(e) => {
          const v = options.find((o) => o.value === e.target.value)?.value;
          if (v !== undefined) onChange(v);
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {dir && onDirChange && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={dir === "asc" ? "Sorted ascending — switch to descending" : "Sorted descending — switch to ascending"}
          title={dir === "asc" ? "Ascending" : "Descending"}
          onClick={() => onDirChange(dir === "asc" ? "desc" : "asc")}
        >
          {dir === "asc" ? <ArrowUpNarrowWide size={15} aria-hidden="true" /> : <ArrowDownWideNarrow size={15} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

/** Toggle chip (aria-pressed) for multi-valued filters such as tags. */
export function FilterChip({ label, pressed, onToggle, count }: { label: string; pressed: boolean; onToggle: () => void; count?: number }) {
  return (
    <button type="button" className={`chip h-7 transition-colors ${pressed ? "chip-accent" : "hover:border-line-strong"}`} aria-pressed={pressed} onClick={onToggle}>
      {label}
      {count !== undefined && <span className="mono text-[10px] font-normal">{count}</span>}
    </button>
  );
}
