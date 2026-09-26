import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

function siteUrl(): URL {
  if (process.env.NEXT_PUBLIC_SITE_URL) return new URL(process.env.NEXT_PUBLIC_SITE_URL);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3000");
}

const PAGES = ["/", "/pay", "/bill/new", "/app", "/break", "/terms"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  // Every docs page comes from the docs source itself, so a new page is listed without editing this file.
  const docs = source.getPages().map((page) => page.url);
  return [...PAGES, ...docs].map((path) => ({ url: new URL(path, base).toString() }));
}
