// Bindings de prueba (se cargan en Miniflare desde vitest.config.ts).
export const TEST_SANDBOX_KEY = "sk_test_sandbox_key_acme_widgets_0001";
// sha256(TEST_SANDBOX_KEY)
export const TEST_SANDBOX_KEY_HASH = "e370d85ffdd4fa62787df853b7c000b2547b61478bb310833d25d5bb130193f0";
export const TEST_REPO_ID = 4242;
export const TEST_AUDIENCE = "ci-cache-test";

export const TEST_BINDINGS = {
  SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
  SANDBOX_KEYS: JSON.stringify({
    [TEST_SANDBOX_KEY_HASH]: { repoId: TEST_REPO_ID, repo: "acme/widgets", label: "prueba" },
  }),
  CACHE_AUDIENCE: TEST_AUDIENCE,
  ALLOWED_OWNERS: "acme,Other-Org",
  MAIN_WRITE_EVENTS: "push",
  MAIN_REFS: "refs/heads/main,refs/heads/master",
  SESSION_TTL_SECONDS: "21600",
};
