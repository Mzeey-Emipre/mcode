import { useState, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import type { CopilotSubagent } from "@mcode/contracts";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";

/** Built-in agents always available regardless of workspace config. */
const DEFAULT_AGENTS: CopilotSubagent[] = [
  {
    name: "interactive",
    displayName: "Ask",
    description: "Answers questions without autonomous tool use.",
    source: "default",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Proposes a plan for approval before executing.",
    source: "default",
  },
  {
    name: "autopilot",
    displayName: "Agent",
    description: "Fully autonomous — runs tools without step-by-step approval.",
    source: "default",
  },
];

interface CopilotAgentSelectorProps {
  /** Currently selected agent name. Defaults to "interactive" if null/undefined. */
  selected: string | null | undefined;
  /** Workspace ID for fetching user/project agents. */
  workspaceId: string;
  /** Prevents selection changes (e.g., locked thread). */
  disabled?: boolean;
  /** Called when the user picks a different agent. */
  onChange: (agentName: string) => void;
}

/** Renders a single agent row with an active indicator and description. */
function AgentItem({
  agent,
  isSelected,
  onSelect,
}: {
  agent: CopilotSubagent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm",
        isSelected ? "text-foreground" : "text-popover-foreground",
      )}
    >
      {/* Fixed-width slot keeps text aligned regardless of selection state. */}
      <span className="mt-[3px] flex w-3 shrink-0 items-center justify-center">
        {isSelected && (
          <Check size={10} className="text-violet-400 dark:text-violet-300" />
        )}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-medium leading-none">{agent.displayName}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          {agent.description}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

/** Section label rendered as all-caps category header with a separator line. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
      {children}
    </DropdownMenuLabel>
  );
}

/**
 * Compact inline dropdown for picking a Copilot sub-agent in the Composer toolbar.
 * Replaces the Chat/Plan toggle when Copilot is the active provider.
 */
export function CopilotAgentSelector({
  selected,
  workspaceId,
  disabled,
  onChange,
}: CopilotAgentSelectorProps) {
  const [userAgents, setUserAgents] = useState<CopilotSubagent[]>([]);
  const [projectAgents, setProjectAgents] = useState<CopilotSubagent[]>([]);

  const effectiveName = selected ?? "interactive";
  const allAgents = [...DEFAULT_AGENTS, ...userAgents, ...projectAgents];
  const activeAgent =
    allAgents.find((a) => a.name === effectiveName) ?? DEFAULT_AGENTS[0];

  useEffect(() => {
    getTransport()
      .listCopilotAgents(workspaceId)
      .then((agents) => {
        setUserAgents(agents.filter((a) => a.source === "user"));
        setProjectAgents(agents.filter((a) => a.source === "project"));
      })
      .catch(() => {
        // Clear stale user/project agents so they don't desync from the workspace.
        setUserAgents([]);
        setProjectAgents([]);
      });
  }, [workspaceId]);

  if (disabled) {
    return (
      <span
        aria-label={`Copilot agent: ${activeAgent.displayName} (locked)`}
        className="flex h-6 items-center gap-1.5 rounded px-1.5 text-sm text-muted-foreground/50"
      >
        {activeAgent.displayName}
        <ChevronDown size={11} />
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Select Copilot agent"
        className="flex h-6 items-center gap-1.5 rounded px-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground data-[state=open]:bg-muted/40 data-[state=open]:text-foreground"
      >
        {activeAgent.displayName}
        <ChevronDown size={11} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[210px]">
        <DropdownMenuGroup>
          <SectionLabel>Default</SectionLabel>
          {DEFAULT_AGENTS.map((agent) => (
            <AgentItem
              key={agent.name}
              agent={agent}
              isSelected={agent.name === effectiveName}
              onSelect={() => onChange(agent.name)}
            />
          ))}
        </DropdownMenuGroup>

        {userAgents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <SectionLabel>User</SectionLabel>
              {userAgents.map((agent) => (
                <AgentItem
                  key={agent.name}
                  agent={agent}
                  isSelected={agent.name === effectiveName}
                  onSelect={() => onChange(agent.name)}
                />
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {projectAgents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <SectionLabel>Project</SectionLabel>
              {projectAgents.map((agent) => (
                <AgentItem
                  key={agent.name}
                  agent={agent}
                  isSelected={agent.name === effectiveName}
                  onSelect={() => onChange(agent.name)}
                />
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
