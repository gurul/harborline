"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "../lib/preferences";

interface PreferencesValue {
  preferences: Preferences;
  /** True once the stored value has been read (after mount). */
  loaded: boolean;
  update: (patch: Partial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

/** Location and access needs, saved on change to this device only. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setPreferences(loadPreferences());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (preferences.largeText) document.documentElement.dataset["text"] = "large";
    else delete document.documentElement.dataset["text"];
  }, [preferences.largeText]);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((previous) => {
      const next = { ...previous, ...patch, version: 1 as const };
      savePreferences(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ preferences, loaded, update }), [preferences, loaded, update]);
  return <PreferencesContext value={value}>{children}</PreferencesContext>;
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside <PreferencesProvider>");
  return value;
}
