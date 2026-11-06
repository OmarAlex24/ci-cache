# ci-cache

Motor de caché de CI sobre Cloudflare R2: un Worker que guarda la caché de Turbo y sccache por repositorio, con un nivel `main/` que solo escribe la CI de `main` y un nivel por rama que escriben el agente en su sandbox y la CI de esa rama.

Sin panel: las métricas salen por una API documentada en OpenAPI.
