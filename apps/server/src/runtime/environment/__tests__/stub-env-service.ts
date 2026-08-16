import type { EnvService } from "../env-service.js";
import { flattenProcessEnv } from "../shell-env-utils.js";

/**
 * Minimal `EnvService` for unit tests that construct providers without the DI container.
 */
export function stubEnvService(): EnvService {
  return {
    getEnv: () => ({ ...flattenProcessEnv(process.env) }),
  } as EnvService;
}
