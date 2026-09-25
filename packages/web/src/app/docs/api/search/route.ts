import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Search runs over the docs text only, on this server, with no third-party search service.
export const { GET } = createFromSource(source);
