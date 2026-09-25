import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({ dir: "content/docs" });

export default defineConfig({
  mdxOptions: {
    // ```mermaid blocks become <Mermaid />, drawn in the browser in the page's own theme.
    remarkPlugins: [remarkMdxMermaid],
    // The docs hold shell commands and addresses; plain code in Adag's tokens reads better than a borrowed syntax theme.
    rehypeCodeOptions: false,
  },
});
