/**
 * The dashboard's providers.
 *
 * Light is the default. `defaultTheme="light"` rather than "system", because a
 * merchant showing this to someone should get the same thing every time rather
 * than whatever that machine's OS happened to be set to - the toggle is how
 * you get dark.
 */
import type { ReactNode } from "react";

import { ThemeProvider } from "./ThemeProvider";
import { SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <TooltipProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
