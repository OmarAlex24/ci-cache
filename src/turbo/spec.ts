// Tipos de la API de Remote Cache de Turborepo (v8), tomados del spec generado en
// AdiRishi/turborepo-remote-cache-cloudflare (packages/spec/turborepo.ts).
// Copyright (c) 2023 Adishwar Rishi. Licencia MIT:
// https://github.com/AdiRishi/turborepo-remote-cache-cloudflare/blob/main/LICENSE

export type CachingStatus = "disabled" | "enabled" | "over_limit" | "paused";

export interface CachingStatusResponse {
  status: CachingStatus;
}

export interface ArtifactUploadResponse {
  /** URLs donde quedó el artefacto (informativo). */
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
