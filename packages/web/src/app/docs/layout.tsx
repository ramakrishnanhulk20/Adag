import "./docs.css";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { ThemeControl } from "@/components/ThemeControl";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    // next-themes stays off: Adag's own head script and ThemeControl already set data-theme, and docs.css follows it.
    <RootProvider theme={{ enabled: false }} search={{ options: { api: "/docs/api/search" } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <span className="font-display text-[20px] font-semibold tracking-[0.08em]">ADAG</span>,
          url: "/",
        }}
        themeSwitch={{ enabled: false }}
        sidebar={{
          // Fumadocs places the footer in a list of sidebar parts, so it needs its own key.
          footer: (
            <div key="adag-theme" className="flex items-center gap-3 pt-3">
              <ThemeControl variant="cycle" tipAlign="start" />
              <span className="type-micro text-muted">Theme</span>
            </div>
          ),
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
