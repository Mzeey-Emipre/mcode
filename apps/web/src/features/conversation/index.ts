/** Public Conversation feature surface for app composition and workbench consumers. */
export { ChatView } from "./messages/ChatView";
export type { ChatViewProps } from "./messages/ChatView";
/** Public composer used by the main conversation and supported workbench flows. */
export {
  Composer,
  ActiveGoalChip,
  isThreadRunningForSubmit,
  shouldQueueActiveThreadSubmit,
} from "./composer/Composer";
/** Public transcript list used by Conversation and child detail views. */
export { MessageList } from "./messages/MessageList";
export type { MessageListProps } from "./messages/MessageList";
/** Public transcript message renderer. */
export { MessageBubble } from "./messages/MessageBubble";
export { NarrativeFlow } from "./narrative";
export type { ThoughtSegment, NarrativeItem } from "./narrative";
export {
  extractSubagentDescription,
  extractToolInputDetail,
  isSubagentLifecycleCall,
  isSubagentLifecycleRecord,
} from "./narrative";
export {
  schedulePrefetch,
  cancelPrefetch,
  prefetchOnPointerDown,
} from "./hydration/prefetch-scheduler";
export { getConversationResidency } from "./residency/conversation-residency";
