interface CookieStore {
  set(details: {
    url: string;
    name: string;
    value: string;
    httpOnly: true;
    sameSite: "strict";
  }): Promise<void> | void;
}

interface ServerConnection {
  port: number;
  authToken: string;
}

/** Install the authenticated server cookie for the local renderer connection. */
export async function installServerAuthCookie(
  cookieStore: CookieStore,
  connection: ServerConnection,
): Promise<void> {
  await cookieStore.set({
    url: `http://localhost:${connection.port}`,
    name: "mcode-auth",
    value: connection.authToken,
    httpOnly: true,
    sameSite: "strict",
  });
}
