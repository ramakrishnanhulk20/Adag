"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useTheme } from "@/components/ThemeProvider";
import { followSiteTheme } from "./appkit";
import { wagmiConfig } from "./config";

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser tab. Created inside state so a server render never shares a cache between visitors.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
        },
      }),
  );
  const { resolved } = useTheme();

  useEffect(() => {
    if (resolved) followSiteTheme(resolved);
  }, [resolved]);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
