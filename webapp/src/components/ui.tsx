import { BookOpen, Calculator, FlaskConical, ListOrdered, Moon, Plus, Sun } from "lucide-react";
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "../theme";

/* ---------- Logo: "ab" ligature in a rounded square, uses currentColor ---------- */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold text-[1.1rem] tracking-tight text-ink">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" fill="none">
        <rect x="1.5" y="1.5" width="29" height="29" rx="8" stroke="currentColor" strokeWidth="1.5" className="text-accent-text" />
        <path d="M8 22l5-12 5 12M10.5 17h5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-text" />
        <path d="M20 10h3.5a3 3 0 010 6H20zM20 16h4a3 3 0 010 6h-4z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" className="text-ink" />
      </svg>
      abkit
    </span>
  );
}

/* ---------- Theme toggle ---------- */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={toggle} className="btn btn-ghost btn-icon" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} aria-pressed={theme === "dark"}>
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/* ---------- Layout ---------- */
const NAV = [
  { to: "/", label: "Experiments", Icon: FlaskConical },
  { to: "/calculator", label: "Calculator", Icon: Calculator },
  { to: "/ranking", label: "Ranking lab", Icon: ListOrdered },
  { to: "/docs", label: "Docs", Icon: BookOpen },
] as const;

/** Name of the page just navigated to: its heading, or the document title without the app suffix. */
function pageName(main: HTMLElement | null): string {
  const heading = main?.querySelector("h1")?.textContent?.trim();
  return heading || document.title.replace(/\s+—\s+abkit\s*$/, "").trim();
}

/**
 * Pathname of the last route the shell handled. Module-level (not a ref) so that a remount of the shell — the route error
 * boundary is keyed by pathname and recreates the tree on navigation — is not mistaken for the first document load.
 */
let lastHandledPathname: string | null = null;

/**
 * App shell. On every client-side route change it scrolls to the top, moves keyboard focus to the `main` landmark (unless
 * the new page already focused one of its own controls) and announces the new page through a polite live region, so
 * keyboard and screen-reader users are not left on a stale element after navigating.
 */
export function Layout() {
  const { pathname } = useLocation();
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    window.scrollTo({ top: 0 });
    if (lastHandledPathname === null) {
      lastHandledPathname = pathname; // initial document load: the browser's own focus handling applies
      return;
    }
    if (lastHandledPathname === pathname) return; // same route re-rendered (e.g. query-string change): nothing to announce
    lastHandledPathname = pathname;
    const main = document.getElementById("main");
    const active = document.activeElement;
    const pageTookFocus = active instanceof HTMLElement && active !== document.body && main !== null && main.contains(active);
    if (main && !pageTookFocus) main.focus({ preventScroll: true });
    setAnnouncement(pageName(main));
  }, [pathname]);
  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <header className="sticky top-0 z-40 bg-bg/85 backdrop-blur-md border-b border-line">
        <div className="wrap h-14 flex items-center justify-between gap-3">
          <Link to="/" aria-label="abkit home" className="shrink-0 rounded-md">
            <Logo />
          </Link>
          <nav className="hidden md:flex gap-1" aria-label="Primary">
            {NAV.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} end={to === "/"} className="nav-link">
                <Icon size={15} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/new" className="btn btn-primary btn-sm">
              <Plus size={15} aria-hidden="true" />
              <span className="hidden sm:inline">New experiment</span>
              <span className="sm:hidden">New</span>
            </Link>
            <a href="https://github.com/D-L-Narayana/abkit" className="btn btn-ghost btn-sm hidden sm:inline-flex" rel="noopener noreferrer" target="_blank">
              GitHub
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1 pb-20 md:pb-0 focus:outline-none" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur border-t border-line grid grid-cols-4 pb-[env(safe-area-inset-bottom)]" aria-label="Mobile">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === "/"} className="tab-link">
            <Icon size={18} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
      <footer className="border-t border-line">
        <div className="wrap py-8 text-sm faint flex flex-col sm:flex-row sm:justify-between gap-3">
          <span>
            abkit — open-source experimentation toolkit by{" "}
            <a className="link" href="https://github.com/D-L-Narayana" rel="noopener noreferrer" target="_blank">D L Narayana</a>. Everything here is simulated or uploaded by you and stays in this browser.
          </span>
          <span>
            Python package + this app:{" "}
            <a className="link" href="https://github.com/D-L-Narayana/abkit" rel="noopener noreferrer" target="_blank">github.com/D-L-Narayana/abkit</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Page scaffold ---------- */
export function Page({ eyebrow, title, lede, right, children }: { eyebrow: string; title: string; lede?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="wrap py-6 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div className="min-w-0">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="text-[clamp(1.4rem,1.1rem+1.2vw,2rem)] leading-tight mt-1">{title}</h1>
          {lede && <p className="muted mt-2 max-w-3xl text-[15px]">{lede}</p>}
        </div>
        {right && <div className="flex flex-wrap gap-2">{right}</div>}
      </div>
      {children}
    </div>
  );
}

export type Tone = "ok" | "bad" | "warn" | "neutral";
const toneText: Record<Tone, string> = { ok: "text-ok", bad: "text-bad", warn: "text-warn", neutral: "" };
export const toneChip: Record<Tone, string> = { ok: "chip-ok", bad: "chip-bad", warn: "chip-warn", neutral: "chip-accent" };

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider faint">{label}</div>
      <div className={`mono text-xl sm:text-2xl font-semibold mt-1 leading-tight break-words ${toneText[tone]}`}>{value}</div>
      {hint && <div className="text-xs faint mt-1">{hint}</div>}
    </div>
  );
}

interface ControlProps { id?: string; "aria-describedby"?: string }

/**
 * Labelled form control. A single child element is linked to the label with `htmlFor`/`id` and to the hint or error with
 * `aria-describedby`, so its accessible name is the label alone and the message is its description. The error is a live
 * alert. Any other children are wrapped in the label as before.
 */
export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }) {
  const base = useId();
  const child = isValidElement<ControlProps>(children) ? children : null;
  const controlId = child?.props.id ?? `${base}-control`;
  const messageId = `${base}-message`;
  const message = error ? <span id={messageId} className="text-xs text-bad mt-1 block" role="alert">{error}</span> : hint ? <span id={messageId} className="text-xs faint mt-1 block">{hint}</span> : null;
  if (!child) {
    return (
      <label className="block min-w-0">
        <span className="label">{label}</span>
        {children}
        {message}
      </label>
    );
  }
  const describedBy = [child.props["aria-describedby"], message ? messageId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="block min-w-0">
      <label htmlFor={controlId} className="label">{label}</label>
      {cloneElement(child, { id: controlId, "aria-describedby": describedBy })}
      {message}
    </div>
  );
}

/**
 * Numeric text field with validation: keeps the raw string while typing and reports it unchanged. Rendered as a plain text
 * input (`inputmode` decimal/numeric) — `min`/`max` only drive the validation message, which is linked through
 * `aria-describedby`; `step` is accepted for compatibility and has no effect on a text input.
 */
export function NumberField({ label, value, onChange, min, max, hint, mono = true, placeholder, integer = false }: { label: string; value: string; onChange: (v: string) => void; min?: number; max?: number; step?: number | "any"; hint?: string; mono?: boolean; placeholder?: string; integer?: boolean }) {
  const n = Number(value);
  const invalid = value.trim() === "" || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max) || (integer && !Number.isInteger(n));
  const range = min !== undefined && max !== undefined ? `between ${min} and ${max}` : min !== undefined ? `at least ${min}` : max !== undefined ? `at most ${max}` : "a number";
  return (
    <Field label={label} hint={hint} error={invalid ? `Enter ${integer ? "a whole number" : "a value"} ${range}.` : null}>
      <input className={`input ${mono ? "mono" : ""}`} type="text" inputMode={integer ? "numeric" : "decimal"} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} placeholder={placeholder} />
    </Field>
  );
}

export function Section({ title, sub, children, className = "" }: { title: string; sub?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`card p-5 ${className}`} aria-labelledby={id}>
      <h2 id={id} className="text-base font-semibold">{title}</h2>
      {sub && <p className="text-xs faint mt-0.5 mb-3">{sub}</p>}
      {children}
    </section>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="card p-10 text-center grid place-items-center gap-3">
      <h2 className="text-lg">{title}</h2>
      <p className="muted max-w-md">{body}</p>
      {action && <div className="flex flex-wrap gap-2 justify-center">{action}</div>}
    </div>
  );
}

/** Small undo toast used after destructive actions. */
export function Toast({ message, actionLabel, onAction, onClose, ttl = 6000 }: { message: string; actionLabel?: string; onAction?: () => void; onClose: () => void; ttl?: number }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, ttl);
    return () => window.clearTimeout(id);
  }, [onClose, ttl]);
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{message}</span>
      <span className="flex gap-1">
        {actionLabel && onAction && (
          <button type="button" className="btn btn-sm" style={{ background: "transparent", color: "inherit", fontWeight: 600 }} onClick={() => { onAction(); onClose(); }}>
            {actionLabel}
          </button>
        )}
        <button type="button" className="btn btn-sm" style={{ background: "transparent", color: "inherit" }} onClick={onClose} aria-label="Dismiss">✕</button>
      </span>
    </div>
  );
}

/** Copy-to-clipboard button with feedback. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      });
    },
  ];
}
