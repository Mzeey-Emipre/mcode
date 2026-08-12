import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const root = resolve(readArgument("--root") ?? "");
const contractFile = resolve(readArgument("--contract") ?? "");
const port = Number(readArgument("--port"));
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error("--root must name the built renderer directory");
}
if (!existsSync(contractFile) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Pass a runtime contract file and a valid port");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__mcode_runtime/ports.json") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(readFileSync(contractFile));
    return;
  }

  const requestedPath = requestUrl.pathname === "/"
    ? "index.html"
    : decodeURIComponent(requestUrl.pathname.slice(1));
  const candidate = resolve(root, normalize(requestedPath));
  const candidateRelative = relative(root, candidate);
  if (candidateRelative.startsWith("..") || candidateRelative.includes(":")) {
    response.writeHead(404).end();
    return;
  }
  const file = existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, "index.html");
  response.writeHead(200, {
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "Content-Type": contentTypes.get(extname(file)) ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ready:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
