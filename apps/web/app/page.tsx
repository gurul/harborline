"use client";

import { Providers } from "./providers";
import { AppShell } from "../components/AppShell";
import { AppStateProvider } from "../components/AppState";
import { PreferencesProvider } from "../components/Preferences";

export default function Page() {
  return (
    <Providers>
      <PreferencesProvider>
        <AppStateProvider>
          <AppShell />
        </AppStateProvider>
      </PreferencesProvider>
    </Providers>
  );
}
