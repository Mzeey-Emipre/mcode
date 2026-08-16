interface HttpListenRetryOptions {
  host: string;
  port: number;
  maxAttempts: number;
  onListening: (port: number) => void;
  onRetry: (port: number, nextPort: number) => void;
  onFailure: (port: number, error: NodeJS.ErrnoException) => void;
}

interface PortRetryServer {
  listen(port: number, host: string): unknown;
  off(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  off(event: "listening", listener: () => void): unknown;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
}

/** Listens on the first available port without retaining callbacks from failed attempts. */
export function listenWithPortRetry(
  server: PortRetryServer,
  options: HttpListenRetryOptions,
  attempt = 1,
): void {
  const onError = (error: NodeJS.ErrnoException): void => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && attempt < options.maxAttempts) {
      options.onRetry(options.port, options.port + 1);
      listenWithPortRetry(
        server,
        { ...options, port: options.port + 1 },
        attempt + 1,
      );
      return;
    }
    options.onFailure(options.port, error);
  };

  const onListening = (): void => {
    server.off("error", onError);
    options.onListening(options.port);
  };

  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(options.port, options.host);
}
