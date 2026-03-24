export type AgentRole = "ticket-agent" | "project-lead" | "conductor";

export interface RoleConfig {
  role: AgentRole;
  isProjectLead: boolean;
  isConductor: boolean;
  maxTurns: number;
  sessionTimeoutMs: number;
  idleTimeoutMs: number;
  persistAfterSession: boolean;
  exitOnError: boolean;
  peRepoRequired: boolean;
  peRepo: string;
}

const PE_REPO = "fryanpan/product-engineer";

const TWO_HOURS = 2 * 60 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export function resolveRoleConfig(agentRole?: string, mode?: string): RoleConfig {
  const isConductor = agentRole === "conductor";
  const isProjectLead = agentRole === "project-lead" || isConductor;
  const isResearchMode = mode === "research";

  const role: AgentRole = isConductor
    ? "conductor"
    : isProjectLead
      ? "project-lead"
      : "ticket-agent";

  if (isProjectLead) {
    return {
      role,
      isProjectLead: true,
      isConductor,
      maxTurns: 1000,
      sessionTimeoutMs: Infinity,
      idleTimeoutMs: Infinity,
      persistAfterSession: true,
      exitOnError: false,
      peRepoRequired: true,
      peRepo: PE_REPO,
    };
  }

  return {
    role: "ticket-agent",
    isProjectLead: false,
    isConductor: false,
    maxTurns: 200,
    sessionTimeoutMs: isResearchMode ? FOUR_HOURS : TWO_HOURS,
    idleTimeoutMs: isResearchMode ? ONE_HOUR : FIVE_MINUTES,
    persistAfterSession: isResearchMode,
    exitOnError: true,
    peRepoRequired: false,
    peRepo: PE_REPO,
  };
}
