import defaultMdxComponents from "fumadocs-ui/mdx";
import { Callout } from "./Callout";
import { Mermaid } from "./Mermaid";

// Every component a docs page may use: Fumadocs' defaults, with Adag's hallmark callout and the Mermaid diagrams.
export const docsComponents = {
  ...defaultMdxComponents,
  Callout,
  Mermaid,
};
