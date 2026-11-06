import { createApp } from "./app.ts";
import { githubJwks } from "./session/oidc.ts";

export default createApp({ jwks: githubJwks });
