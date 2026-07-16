import type {
  PullRequestCapabilitiesRequest,
  PullRequestCapabilitiesResult,
  PullRequestCancelRequest,
  PullRequestCancelResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestGetRequest,
  PullRequestGetResult,
  PullRequestTimelineRequest,
  PullRequestTimelineResult,
  PullRequestFilesRequest,
  PullRequestFilesResult,
  PullRequestPatchRequest,
  PullRequestPatchResult,
} from "@mcode/contracts";
import { getTransport } from "./index";

/** Pull request RPC subset consumed by the inbox store. */
export interface PullRequestTransport {
  /** Resolve capabilities for the authenticated viewer. */
  getCapabilities(
    request: PullRequestCapabilitiesRequest,
  ): Promise<PullRequestCapabilitiesResult>;
  /** Load one bounded inbox page. */
  list(request: PullRequestListRequest): Promise<PullRequestListResult>;
  /** Load one bounded detail, checks, or comments resource. */
  get(request: PullRequestGetRequest): Promise<PullRequestGetResult>;
  /** Load one bounded Timeline page. */
  timeline(request: PullRequestTimelineRequest): Promise<PullRequestTimelineResult>;
  /** Load one filtered and bounded changed-file page. */
  files(request: PullRequestFilesRequest): Promise<PullRequestFilesResult>;
  /** Load one immutable, snapshot-qualified changed-file patch. */
  patch(request: PullRequestPatchRequest): Promise<PullRequestPatchResult>;
  /** Cancel a connection-owned inbox operation. */
  cancel(request: PullRequestCancelRequest): Promise<PullRequestCancelResult>;
}

/** Create the named pull request transport over the active Mcode connection. */
export function getPullRequestTransport(): PullRequestTransport {
  const transport = getTransport();
  return {
    getCapabilities: (request) => transport.getPullRequestCapabilities(request),
    list: (request) => transport.listPullRequests(request),
    get: (request) => transport.getPullRequestResource(request),
    timeline: (request) => transport.getPullRequestTimeline(request),
    files: (request) => transport.getPullRequestFiles(request),
    patch: (request) => transport.getPullRequestPatch(request),
    cancel: (request) => transport.cancelPullRequestOperation(request),
  };
}
