import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { EmptyState, Layout, Page } from "./components/ui";
import { CalculatorPage } from "./pages/Calculator";
import { Dashboard } from "./pages/Dashboard";
import { Docs } from "./pages/Docs";
import { RankingLab } from "./pages/RankingLab";
import { Results } from "./pages/Results";
import { UploadPage } from "./pages/Upload";
import { Wizard } from "./pages/Wizard";
import "./index.css";

function NotFound() {
  return (
    <Page eyebrow="404" title="Page not found">
      <EmptyState title="That address doesn't exist" body="The experiments list is one click away." action={<Link to="/" className="btn btn-primary btn-sm">Back to experiments</Link>} />
    </Page>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="new" element={<Wizard />} />
          <Route path="exp/:id" element={<Results />} />
          <Route path="share/:id" element={<Results shared />} />
          <Route path="calculator" element={<CalculatorPage />} />
          <Route path="ranking" element={<RankingLab />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
