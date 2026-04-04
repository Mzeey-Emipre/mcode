# Settings Schema Conventions

Mcode uses a `settings.json` file as the single source of truth for user preferences. This document defines the schema structure, naming rules, and conventions that all settings must follow.

**Location:** `~/.mcode/settings.json` (resolved via `getMcodeDataDir()`)

## Structure Rules

### 1. Every setting lives inside a category object

No bare top-level keys. Even a single setting gets a category.

```jsonc
// Good
{ "notifications": { "enabled": true } }

// Bad
{ "notificationsEnabled": true }
```

**Why:** Categories group related settings and keep the door open for future siblings (e.g., `notifications.sound`) without restructuring.

### 2. Nest when 2+ settings share a qualifier

If a category has multiple settings that share a common qualifier, group them under a nested object.

```jsonc
// Good: "mode" and "permission" both qualify as "defaults"
{
  "agent": {
    "maxConcurrent": 5,
    "defaults": {
      "mode": "chat",
      "permission": "full"
    }
  }
}

// Bad: flat siblings with repeated prefix
{
  "agent": {
    "maxConcurrent": 5,
    "defaultMode": "chat",
    "defaultPermission": "full"
  }
}
```

**The test:** "Do I have 2+ settings that share a common qualifier?" If yes, nest under that qualifier. If no, keep flat within the category.

### 3. Max depth: 3 levels

Settings must not exceed 3 levels of nesting: `category.qualifier.setting`. If you find yourself at 4 levels, flatten.

```jsonc
// Good: 3 levels
{ "model": { "defaults": { "reasoning": "high" } } }

// Bad: 4 levels
{ "model": { "defaults": { "reasoning": { "level": "high" } } } }
```

### 4. Single settings stay flat within their category

When a category has only one setting or settings that don't share a qualifier, keep them as direct properties.

```jsonc
// Good: standalone settings within a category
{
  "appearance": { "theme": "system" },
  "terminal": { "scrollback": 500 }
}
```

**Exception:** If a property name would require a qualifier prefix (e.g., `memoryHeapMb` where "memory" qualifies "heap"), extract that prefix as a nested key even if it currently has only one child:

```jsonc
// Good: qualifier extracted as nested key
{ "server": { "memory": { "heapMb": 512 } } }

// Bad: qualifier baked into property name
{ "server": { "memoryHeapMb": 512 } }
```

### 5. Use camelCase for property names

All property names use camelCase, matching the TypeScript codebase convention.

```jsonc
// Good
{ "agent": { "maxConcurrent": 5 } }

// Bad
{ "agent": { "max_concurrent": 5 } }
{ "agent": { "max-concurrent": 5 } }
```

## Decision Checklist

When adding a new setting, ask these questions in order:

1. **Which category does it belong to?** Pick an existing category or create a new one if no existing category fits.
2. **Does it share a qualifier with sibling settings?** If 2+ settings share a prefix (e.g., "default"), nest them under that qualifier.
3. **Does the property name contain a qualifier prefix?** If the name reads as `qualifierSetting` (e.g., `memoryHeapMb` within a `server` category), extract the qualifier as a nested key (`memory.heapMb`), even if it is the only child. The resulting path must stay within 3 levels total (category → qualifier → setting).
4. **Am I at 3 levels or fewer?** If the nesting would exceed 3, flatten by removing the least meaningful level.
5. **Does the single-setting category still make sense?** Even one setting gets a category, but the category name should be broad enough to accept future siblings.

## Current Schema

```jsonc
{
  "appearance": {
    "theme": "system"                  // "system" | "dark" | "light"
  },
  "agent": {
    "maxConcurrent": 5,
    "defaults": {
      "mode": "chat",                  // "plan" | "chat" | "agent"
      "permission": "full"             // "full" | "supervised"
    }
  },
  "model": {
    "defaults": {
      "provider": "claude",            // "claude" | "codex" | "gemini" | "copilot"
      "id": "claude-sonnet-4-6",
      "reasoning": "high",             // "low" | "medium" | "high"
      "fallbackId": "claude-sonnet-4-6" // "" disables fallback
    }
  },
  "terminal": {
    "scrollback": 500
  },
  "notifications": {
    "enabled": true
  },
  "worktree": {
    "naming": {
      "mode": "auto",                  // "auto" | "custom" | "ai"
      "aiConfirmation": true
    }
  },
  "server": {
    "memory": {
      "heapMb": 512                    // 64-8192, V8 max old space (MB)
    }
  },
  "provider": {
    "cli": {
      "codex": "",                     // Path to codex CLI, empty = auto-discover
      "claude": ""                     // Path to claude CLI, empty = auto-discover
    }
  }
}
```

## Adding New Settings

1. Follow the rules above.
2. Add the setting to the "Current Schema" section in this document and to `docs/settings/reference.md`.
3. Add a Zod schema for the new setting in `packages/contracts/`.
4. Provide a sensible default so the app works without a `settings.json` file.
5. Settings must be optional and merge over defaults. A missing key means "use default", never an error.
