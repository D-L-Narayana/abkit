import type { ReactNode } from "react";
import { sections as core } from "./core";
import { sections as data } from "./data";
import { sections as effects } from "./effects";
import { sections as interleaving } from "./interleaving";
import { sections as sequential } from "./sequential";

/** One methodology section on the Docs page. Each topic module exports `sections: DocSection[]`. */
export interface DocSection {
  id: string;
  title: string;
  body: ReactNode;
  group: "tests" | "planning" | "guardrails" | "sequential" | "ranking" | "data";
}

export const GROUP_LABELS: Record<DocSection["group"], string> = {
  tests: "Hypothesis tests",
  planning: "Planning & power",
  guardrails: "Guardrails & variance",
  sequential: "Sequential testing",
  ranking: "Ranking evaluation",
  data: "Data & sharing",
};

const GROUP_ORDER: DocSection["group"][] = ["tests", "planning", "guardrails", "sequential", "ranking", "data"];

/** All sections, grouped in a stable order; ids must be unique across modules. */
export function allSections(): DocSection[] {
  const all = [...core, ...effects, ...sequential, ...interleaving, ...data];
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.id)) throw new Error(`duplicate docs section id: ${s.id}`);
    seen.add(s.id);
  }
  return GROUP_ORDER.flatMap((g) => all.filter((s) => s.group === g));
}
