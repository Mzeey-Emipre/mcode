import { createNarrativeCounts } from "./narrative-builder-helpers";
import {
  prepareLiveNarrative,
  projectLiveNarrativeItems,
  type LiveNarrativeInputs,
} from "./live-narrative-timeline";
import type { NarrativeBuildResult } from "./types";

export {
  computeLiveStreamingText,
  filterThoughtsMatchingAssistantBody,
} from "./narrative-thought-classification";

/** Transforms live turn state into chronological timeline rows and aggregate counts. */
export function buildNarrativeItems(
  params: LiveNarrativeInputs,
): NarrativeBuildResult {
  const preparation = prepareLiveNarrative(params);
  const items = projectLiveNarrativeItems(preparation, params);
  return {
    items,
    counts: createNarrativeCounts(preparation.topLevelCalls, items),
  };
}
