import type {
  CursorProviderBoundary,
  ProviderFactoryInput,
} from "../../factory-types.js";
import {
  bindProviderProtocol,
  createProviderBoundary,
  type ProviderProtocolBinding,
} from "../factory.js";
import { CursorProvider } from "../cursor/cursor-provider.js";

const MAX_ACP_METHOD_LENGTH = 256;
const MAX_ACP_REQUEST_BYTES = 1_048_576;

const acpProtocol: ProviderProtocolBinding = {
  kind: "acp",
  encodeRequest(method, params) {
    if (method.length < 1 || method.length > MAX_ACP_METHOD_LENGTH) {
      throw new TypeError("ACP method is invalid");
    }
    const request = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    if (Buffer.byteLength(request, "utf8") > MAX_ACP_REQUEST_BYTES) {
      throw new RangeError("ACP request exceeds the maximum encoded size");
    }
    return request;
  },
};

/** Composes Cursor with the package-private generic ACP factory seam. */
export function createCursorAcpProvider(input: ProviderFactoryInput): CursorProviderBoundary {
  createProviderBoundary("cursor", [], input);
  if (!input.cursor) throw new TypeError("Cursor Provider ports are required");
  if (typeof input.cursor.settings?.get !== "function") {
    throw new TypeError("Cursor Provider port settings.get is required");
  }
  if (typeof input.cursor.skills?.list !== "function") {
    throw new TypeError("Cursor Provider port skills.list is required");
  }
  const provider = new CursorProvider(input.host, input.cursor, input.configuration.idleSessionTtlMs);
  bindProviderProtocol(provider, acpProtocol);
  return provider;
}
