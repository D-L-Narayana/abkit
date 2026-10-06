/**
 * Error boundary for the app shell. A render error in one page no longer blanks the whole app: the visitor sees what
 * happened, can retry the same view, copy a diagnostic report, or go back to the experiments list.
 *
 * `ErrorBoundary` is the plain class component (usable anywhere). `RouteErrorBoundary` keys it by pathname so navigating
 * (including the browser's back button) automatically clears a caught error.
 */
import { AlertTriangle, Check, Copy, Home, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Destination of the "Back to experiments" link (a full navigation, so corrupt in-memory state is discarded). */
  homeHref?: string;
  title?: string;
  onReset?: () => void;
}
interface ErrorBoundaryState { error: Error | null; componentStack: string | null; copied: "idle" | "done" | "failed" }

const toError = (x: unknown): Error => (x instanceof Error ? x : new Error(typeof x === "string" ? x : JSON.stringify(x) ?? "Unknown error"));

/** Plain-text diagnostic report (what "Copy error details" puts on the clipboard). */
export function errorReport(error: Error | null, componentStack: string | null): string {
  const lines = [
    "abkit error report",
    `time: ${new Date().toISOString()}`,
    typeof location !== "undefined" ? `page: ${location.href}` : "",
    typeof navigator !== "undefined" ? `agent: ${navigator.userAgent}` : "",
    "",
    error ? `${error.name}: ${error.message}` : "unknown error",
    error?.stack ?? "",
  ];
  if (componentStack) lines.push("", "component stack:", componentStack.trim());
  return lines.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, copied: "idle" };
  private timer: number | undefined;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error), copied: "idle" };
  }
  componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
  }
  componentWillUnmount(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null, copied: "idle" });
    this.props.onReset?.();
  };
  copy = async (): Promise<void> => {
    const text = errorReport(this.state.error, this.state.componentStack);
    try {
      await navigator.clipboard.writeText(text);
      this.flash("done");
    } catch {
      this.flash("failed");
    }
  };
  private flash(copied: ErrorBoundaryState["copied"]): void {
    this.setState({ copied });
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.setState({ copied: "idle" }), 2200);
  }

  render(): ReactNode {
    const { error, componentStack, copied } = this.state;
    if (!error) return this.props.children;
    const { homeHref = "/", title = "Something went wrong" } = this.props;
    const report = errorReport(error, componentStack);
    return (
      <div className="wrap py-10">
        <div role="alert" className="card p-6 md:p-8 max-w-2xl mx-auto grid gap-4">
          <div className="flex items-start gap-3">
            <span className="grid place-items-center size-10 rounded-xl bg-bad-soft text-bad-ink shrink-0" aria-hidden="true">
              <AlertTriangle size={20} />
            </span>
            <div className="min-w-0">
              <span className="eyebrow">Error</span>
              <h1 className="text-xl leading-tight mt-1">{title}</h1>
              <p className="muted mt-2 text-[15px]">
                This view hit an unexpected error while rendering. Your experiments are safe — they live in this browser's storage and were not changed by the error.
              </p>
            </div>
          </div>
          <p className="mono text-sm bg-bg2 border border-line rounded-lg px-3 py-2 break-words">{error.name}: {error.message}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={this.reset}><RotateCcw size={14} aria-hidden="true" /> Try again</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void this.copy()} aria-live="polite">
              {copied === "done" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed — use the details below" : "Copy error details"}
            </button>
            <a className="btn btn-ghost btn-sm" href={homeHref}><Home size={14} aria-hidden="true" /> Back to experiments</a>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer muted">Technical details</summary>
            <pre className="formula mt-2 text-xs whitespace-pre-wrap break-words">{report}</pre>
          </details>
        </div>
      </div>
    );
  }
}

/** Error boundary that resets itself whenever the route changes. Must be rendered inside the router. */
export function RouteErrorBoundary({ children, homeHref }: { children: ReactNode; homeHref?: string }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname} homeHref={homeHref}>{children}</ErrorBoundary>;
}
