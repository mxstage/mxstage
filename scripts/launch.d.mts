// scripts/launch.mjs の型（橋渡しの試験から読むため。台本そのものは依存の無い JavaScript のまま写す）

export interface LaunchRef {
  commit: string;
  dir: string;
  version: string | null;
  preparedAt: number | null;
}

export interface LaunchState {
  schema: 1;
  seed: { entry: string; root: string | null } | null;
  current: LaunchRef | null;
  ready: LaunchRef | null;
  previous: LaunchRef | null;
  lastPrepare: unknown;
  lastCheck: unknown;
  [key: string]: unknown;
}

export interface LaunchChoice {
  entry: string | null;
  root: string | null;
  source: "ready" | "current" | "seed" | null;
  promoted: boolean;
  next: LaunchState;
}

export const VERSIONS_FILE: string;
export const VERSIONS_DIR: string;
export const READY_MARKER: string;
export const VERSION_ENTRY: string[];
export const VERSION_APP: string[];
export const LAUNCHER_ENV: string;
export function readVersions(stateDir: string): LaunchState;
export function writeVersions(stateDir: string, state: LaunchState): void;
export function versionEntry(dir: string): string;
export function versionComplete(dir: string, exists?: (p: string) => boolean): boolean;
export function chooseLaunch(state: LaunchState, exists?: (p: string) => boolean): LaunchChoice;
