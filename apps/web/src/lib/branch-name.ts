const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "no", "so", "if", "then", "than", "too", "very", "just",
  "about", "up", "out", "this", "that", "it", "i", "we", "you", "they",
  "me", "my", "our", "your", "he", "she", "his", "her", "its",
  "hey", "hi", "hello", "please", "thanks", "need", "want", "like",
]);

export function sanitizeBranchName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function generateBranchNameFromMessage(message: string): string {
  const words = message
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const meaningful = words.slice(0, 5);
  if (meaningful.length === 0) {
    return `thread-${Date.now().toString(36)}`;
  }
  return sanitizeBranchName(meaningful.join("-"));
}

export function generateFallbackBranchName(): string {
  return `thread-${Date.now().toString(36)}`;
}
