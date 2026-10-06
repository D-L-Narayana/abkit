import { useEffect, useMemo, useState } from "react";
import { Page } from "../components/ui";
import { GROUP_LABELS, allSections, type DocSection } from "../docs/index";
import { useTitle } from "../theme";

export function Docs() {
  useTitle("Docs — abkit");
  const sections = useMemo(() => allSections(), []);
  const [active, setActive] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-20% 0px -60% 0px" });
    sections.forEach((d) => { const el = document.getElementById(d.id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [sections]);
  const groups = useMemo(() => {
    const out: { group: DocSection["group"]; items: DocSection[] }[] = [];
    for (const s of sections) {
      const last = out[out.length - 1];
      if (last && last.group === s.group) last.items.push(s); else out.push({ group: s.group, items: [s] });
    }
    return out;
  }, [sections]);
  return (
    <Page eyebrow="Methodology" title="Docs" lede="The formulas behind every number in the app, with the Monte-Carlo evidence for the guardrails.">
      <div className="grid lg:grid-cols-[240px_1fr] gap-6">
        {/* Section titles can run to two or three lines, so the links grow with their text (the shared .nav-link rule is a fixed
            2.25rem row) and the whole list scrolls inside the sticky column when it is taller than the viewport. */}
        <nav className="hidden lg:grid sticky top-20 self-start text-sm gap-3 max-h-[calc(100dvh-6rem)] overflow-y-auto pr-1" aria-label="Sections">
          {groups.map((g) => (
            <div key={g.group} className="grid gap-0.5">
              <span className="label mb-0 px-3">{GROUP_LABELS[g.group]}</span>
              {g.items.map((d) => (
                <a key={d.id} href={`#${d.id}`} className="nav-link h-auto min-h-9 py-1.5 leading-snug" aria-current={active === d.id ? "page" : undefined}>{d.title}</a>
              ))}
            </div>
          ))}
        </nav>
        <div className="grid gap-4">
          {sections.map((d, i) => (
            <section key={d.id} id={d.id} className={`card p-5 md:p-6 rise rise-d${Math.min(i, 3)} grid gap-3 leading-relaxed text-[15px] scroll-mt-20`} aria-labelledby={`${d.id}-h`}>
              <span className="eyebrow">{GROUP_LABELS[d.group]}</span>
              <h2 id={`${d.id}-h`} className="text-lg">{d.title}</h2>
              {d.body}
            </section>
          ))}
          <p className="text-xs faint">Everything on this page is implemented in the <a className="link" href="https://github.com/D-L-Narayana/abkit" rel="noopener noreferrer" target="_blank">Python package</a> (with pytest checks against SciPy) and mirrored in TypeScript for this app.</p>
        </div>
      </div>
    </Page>
  );
}
