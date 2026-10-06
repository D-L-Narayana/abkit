import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { RouteErrorBoundary } from "./components/ErrorBoundary";
import { EmptyState, Layout, Page } from "./components/ui";
import { CalculatorPage } from "./pages/Calculator";
import { Dashboard } from "./pages/Dashboard";
import { Docs } from "./pages/Docs";
import { RankingLab } from "./pages/RankingLab";
import { Results } from "./pages/Results";
import { UploadPage } from "./pages/Upload";
import { Wizard } from "./pages/Wizard";
// Self-hosted variable fonts (bundled into dist/assets) so the strict Content-Security-Policy needs no third-party origins.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

function NotFound() {
  return (
    <Page eyebrow="404" title="Page not found">
      <EmptyState title="That address doesn't exist" body="The experiments list is one click away." action={<Link to="/" className="btn btn-primary btn-sm">Back to experiments</Link>} />
    </Page>
  );
}

/**
 * A render error in one page shows a recoverable error card instead of a blank app. The boundary wraps each page element
 * (not the whole route tree): it is keyed by pathname so it resets on navigation, and keeping it inside the layout route
 * means the app shell — header, navigation, skip link, live region and the `main` landmark — persists across navigations
 * instead of being remounted with every page change.
 */
const guarded = (page: ReactNode): ReactNode => <RouteErrorBoundary>{page}</RouteErrorBoundary>;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={guarded(<Dashboard />)} />
          <Route path="new" element={guarded(<Wizard />)} />
          <Route path="exp/:id" element={guarded(<Results />)} />
          <Route path="share/:id" element={guarded(<Results shared />)} />
          <Route path="calculator" element={guarded(<CalculatorPage />)} />
          <Route path="ranking" element={guarded(<RankingLab />)} />
          <Route path="upload" element={guarded(<UploadPage />)} />
          <Route path="docs" element={guarded(<Docs />)} />
          <Route path="*" element={guarded(<NotFound />)} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
