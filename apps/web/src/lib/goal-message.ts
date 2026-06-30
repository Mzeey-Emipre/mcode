/** Render hint for an assistant message that represents goal lifecycle state. */
export interface GoalStatusNotice {
  label: string;
  condition?: string;
  hint?: string;
}

/** Parses server-emitted goal lifecycle messages from assistant content. */
export function parseGoalStatusNotice(content: string): GoalStatusNotice | null {
  const text = content.trim();
  let match = /^Goal set: "([\s\S]+?)"\.$/.exec(text);
  if (match) return { label: "Goal set", condition: match[1], hint: "/goal clear to remove" };
  match = /^Active goal: "([\s\S]+?)"\.$/.exec(text);
  if (match) return { label: "Active goal", condition: match[1], hint: "/goal clear to remove" };
  match = /^Goal achieved in (\d+)s\.$/.exec(text);
  if (match) return { label: "Goal achieved", hint: `${match[1]}s` };
  if (/^Goal cleared\.$/.test(text)) return { label: "Goal cleared" };
  if (/^No active goal\.$/.test(text)) return { label: "No active goal", hint: "/goal <condition> to set one" };
  return null;
}

/** Returns true when assistant content is a goal lifecycle notice. */
export function isGoalStatusNotice(content: string): boolean {
  return parseGoalStatusNotice(content) !== null;
}
