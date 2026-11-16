// Types for Turborepo's Remote Cache API (v8), taken from the generated spec in
// AdiRishi/turborepo-remote-cache-cloudflare (packages/spec/turborepo.ts).
// Copyright (c) 2023 Adishwar Rishi. MIT License:
// https://github.com/AdiRishi/turborepo-remote-cache-cloudflare/blob/main/LICENSE

export type CachingStatus = "disabled" | "enabled" | "over_limit" | "paused";

export interface CachingStatusResponse {
  status: CachingStatus;
}

export interface ArtifactUploadResponse {
  /** URLs where the artifact was stored (informational). */
  urls: string[];
}

export interface ArtifactQueryRequest {
  hashes: string[];
}

export interface ArtifactInfo {
  size: number;
  taskDurationMs: number;
  tag?: string;
}

export interface ArtifactError {
  error: { message: string };
}

export type ArtifactQueryResponse = Record<string, ArtifactInfo | ArtifactError | null>;

export interface CacheEvent {
  sessionId?: string;
  source: "LOCAL" | "REMOTE";
  event: "HIT" | "MISS";
  hash: string;
  duration?: number;
}
