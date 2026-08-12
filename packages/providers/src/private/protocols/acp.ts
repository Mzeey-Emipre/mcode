import type { ProviderBoundary, ProviderFactoryInput } from "../../factory-types.js";
import {
  createProviderBoundary,
  type ProviderProtocolBinding,
} from "../factory.js";

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
export function createCursorAcpProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("cursor", [], input, acpProtocol);
}
