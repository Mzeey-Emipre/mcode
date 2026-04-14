/**
 * Scans a port range to find the mcode server and returns a WebSocket URL
 * with a fresh auth token read from the health endpoint response.
 */
export async function scanPortRange(
  portMin: number,
  portMax: number,
  token: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    // Race all probes. The first healthy response resolves the outer promise
    // and aborts all remaining probes via the shared AbortController.
    const result = await new Promise<{ port: number; freshToken: string }>(
      (resolve, reject) => {
        let remaining = portMax - portMin;
        Array.from({ length: remaining }, (_, i) => {
          const p = portMin + i;
          fetch(`http://localhost:${p}/health`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          })
            .then(async (r) => {
              if (r.ok) {
                controller.abort(); // cancel remaining probes
                // Read fresh token from health response so stale tokens from
                // a previous server instance don't cause 4001 rejections.
                let freshToken = token;
                try {
                  const body = await r.json();
                  if (typeof body.authToken === "string" && body.authToken.length > 0) freshToken = body.authToken;
                } catch {
                  // Fall back to saved token if response parsing fails
                }
                resolve({ port: p, freshToken });
              } else {
                if (--remaining === 0) reject(new Error("none found"));
              }
            })
            .catch(() => {
              if (--remaining === 0) reject(new Error("none found"));
            });
        });
      },
    );

    // Persist the fresh token so future reconnects use it rather than a stale one.
    // freshToken is always set (initialized to `token`, overwritten on success).
    localStorage.setItem("mcode-auth-token", result.freshToken);

    return `ws://localhost:${result.port}?token=${result.freshToken}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
