# Tool Call UX Test Prompts

Test prompts for verifying tool call rendering. Run these against any small project with a few config files, components, and a package.json.

---

## 1. Basic Tool Calls (single type)

### Read-heavy
```
Read every file in this project and tell me what you find.
```

### Write-heavy
```
Create a full component library: Button.vue, Input.vue, Card.vue, Modal.vue, and Badge.vue in src/components/ui/. Each should have props, slots, and emits with full TypeScript typing.
```

### Bash-heavy
```
Check the Node version, list all installed packages, check for outdated deps, show disk usage of node_modules, and run the linter.
```

### Search-heavy
```
Search the entire project for any TODO comments, unused imports, TypeScript errors, and console.log statements. Also find all files that import from vue.
```

---

## 2. Mixed Tool Calls (grouping and variety)

### Explore then modify
```
Analyze the full project structure, read every config file, then add Vue Router with a Home and About page. Create the router config, both page components, and update App.vue to use router-view.
```

### Read, edit, verify loop
```
Read App.vue, refactor it to use script setup with a reactive counter, a computed doubled value, and a watch that logs changes. Then read it back to verify your changes are correct.
```

---

## 3. Subagent / Agent Tool Calls (nesting)

### Single subagent
```
Use a subagent to audit this project's configuration files and report findings.
```

### Multiple subagents
```
Use parallel subagents to: (1) analyze the TypeScript config, (2) analyze the Vite config, (3) analyze the ESLint config. Then synthesize their findings.
```

### Deep nesting
```
Use a subagent to build a complete Pinia store with unit tests. The subagent should create the store, write tests, and run them.
```

---

## 4. Long-running Operations

### Slow bash
```
Install Pinia, Vue Router, and VueUse. Then run a full build and report any errors.
```

### Many sequential steps
```
Set up this project from scratch with: Vue Router (2 routes), Pinia (1 store), a fetch composable, an API service layer, and a dashboard page that uses all of them. Work step by step.
```

---

## 5. Edge Cases

### Rapid tool calls (timing)
```
Read all 3 tsconfig files simultaneously and compare their compiler options.
```

### Tool call with errors
```
Try to read a file called src/nonexistent.ts, then try to run a command that will fail like `npm run nonexistent`, then recover and do something useful.
```

### Empty/minimal turn
```
What is 2+2?
```
_Expected: no tool calls, just a text response. Verify no ghost tool call UI appears._

### Immediate follow-up (queue testing)
Send these back-to-back while the agent is still running:
```
Read package.json
```
```
Also read vite.config.ts
```

### Very large output
```
Run `npm ls --all` and show me the full dependency tree.
```

### Tool call then long text response
```
Read App.vue, then write a 500-word essay about Vue 3's Composition API and how it compares to the Options API.
```

---

## 6. Summary View Testing

### Verify post-turn summary
After any prompt completes, verify:
- [ ] "Completed N steps" appears below the assistant message
- [ ] Clicking expands to show grouped steps
- [ ] Step rows show correct icons and counts
- [ ] Agent/subagent steps show purple gutter with expand
- [ ] Expanding a multi-call group shows individual calls
- [ ] No active/spinning styling on completed summaries

### Verify live tool call display
While the agent is running, verify:
- [ ] Active tool calls show blue gutter + shimmer text
- [ ] Subagent calls nest under purple "Thinking deeper..." row
- [ ] Only incomplete calls shown (not accumulated history)
- [ ] Completed calls fade out after turn ends
- [ ] "N subagents running" badge appears in status bar

---

## 7. Stress Tests

### Many tool calls
```
I want you to make at least 30 tool calls. Read every file, search for patterns, list directories, check configs, run commands, and be thorough. Leave no stone unturned.
```

### Concurrent subagents with many children
```
Use 3 parallel subagents. Each should: read all config files, search for patterns, run commands, and create a new file. I want to see at least 40 total tool calls across all subagents.
```

### Rapid thread switching
Open two threads. Start a long task in thread A, switch to thread B and start another task, then switch back to A. Verify:
- [ ] Tool calls don't leak between threads
- [ ] Switching back shows correct state
- [ ] Summaries appear on the correct messages
