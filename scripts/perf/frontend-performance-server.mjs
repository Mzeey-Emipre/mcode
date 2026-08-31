import * as NodeFS from "node:fs";
import * as NodeHTTP from "node:http";
import * as NodePath from "node:path";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const root = NodePath.resolve(readArgument("--root") ?? "");
const contractFile = NodePath.resolve(readArgument("--contract") ?? "");
const port = Number(readArgument("--port"));
if (!NodeFS.existsSync(root) || !NodeFS.statSync(root).isDirectory()) {
  throw new Error("--root must name the built renderer directory");
}
if (!NodeFS.existsSync(contractFile) || !Number.isInteger(port) || port < 1 || port > 65_535) {
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

const server = NodeHTTP.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__mcode_runtime/ports.json") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(NodeFS.readFileSync(contractFile));
    return;
  }

  const requestedPath = requestUrl.pathname === "/"
    ? "index.html"
    : decodeURIComponent(requestUrl.pathname.slice(1));
  const candidate = NodePath.resolve(root, NodePath.normalize(requestedPath));
  const candidateRelative = NodePath.relative(root, candidate);
  if (candidateRelative.startsWith("..") || candidateRelative.includes(":")) {
    response.writeHead(404).end();
    return;
  }
  const file = NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()
    ? candidate
    : NodePath.join(root, "index.html");
  response.writeHead(200, {
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "Content-Type": contentTypes.get(NodePath.extname(file)) ?? "application/octet-stream",
  });
  NodeFS.createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ready:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
