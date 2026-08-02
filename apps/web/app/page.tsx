"use client";

import { Providers } from "./providers";
import { AppStateProvider } from "../components/AppState";
import { AssistantPanel } from "../components/AssistantPanel";
import { FeedPanel } from "../components/FeedPanel";
import { Header } from "../components/Header";
import { MapPanel } from "../components/MapPanel";

export default function Page() {
  return (
    <Providers>
      <AppStateProvider>
        <div className="flex min-h-dvh flex-col bg-hl-bg">
          <Header />

          <main
            aria-label="Harborline situational view"
            className="mx-auto w-full max-w-[1800px] flex-1 px-4 py-4 sm:px-6 sm:py-6"
          >
            <div className="grid gap-4 lg:h-[calc(100dvh-11rem)] lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)_minmax(320px,1fr)] lg:gap-5">
              <MapPanel />
              <FeedPanel />
              <AssistantPanel />
            </div>
          </main>

          <footer className="border-t border-hl-line/70 px-4 py-5 sm:px-6">
            <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-hl-dim">
                Designed for calm in moments of chaos.
              </p>
              <p className="text-[10px] text-hl-dim">
                Records determine the facts. Routing is a demonstration.
              </p>
            </div>
          </footer>
        </div>
      </AppStateProvider>
    </Providers>
  );
}
