/** Start the Mcode server process. */
import { startServer } from "./application/bootstrap/server-bootstrap.js";

void startServer().catch((error: unknown) => {
  console.error("Mcode server startup failed", error);
  process.exit(1);
});
