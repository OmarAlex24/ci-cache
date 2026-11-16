// Test bindings (loaded into Miniflare from vitest.config.ts).
export const TEST_SANDBOX_KEY = "sk_test_sandbox_key_acme_widgets_0001";
// sha256(TEST_SANDBOX_KEY)
export const TEST_SANDBOX_KEY_HASH = "e370d85ffdd4fa62787df853b7c000b2547b61478bb310833d25d5bb130193f0";
export const TEST_REPO_ID = 4242;
export const TEST_AUDIENCE = "ci-cache-test";
// Read-only /v1/stats keys: one sees everything, the other only repo 4242.
export const TEST_STATS_KEY = "rk_test_stats_key_all_0001";
export const TEST_STATS_KEY_4242 = "rk_test_stats_key_only_4242";

export const TEST_BINDINGS = {
  SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
  SANDBOX_KEYS: JSON.stringify({
    [TEST_SANDBOX_KEY_HASH]: { repoId: TEST_REPO_ID, repo: "acme/widgets", label: "test" },
  }),
  STATS_KEYS: JSON.stringify({
    e8eb5b4e3d500d95485395236c566d93f5bfb8ea7f9a214e75b1731dfd3c32eb: { label: "all" },
    f9ae4c97846a61a44ff5a9a30bc37854734ba6b0d3830d123f9644fff3ad4eae: { label: "only 4242", repoIds: [TEST_REPO_ID] },
  }),
  CACHE_AUDIENCE: TEST_AUDIENCE,
  ALLOWED_OWNERS: "acme,Other-Org",
  MAIN_WRITE_EVENTS: "push",
  MAIN_REFS: "refs/heads/main,refs/heads/master",
  SESSION_TTL_SECONDS: "21600",
  REUSE_ALERT_MIN_WRITES: "3",
};
