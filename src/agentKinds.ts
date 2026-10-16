export const LEAD_KIND = "lead";
export const LEAD_ACTOR_PREFIX = `${LEAD_KIND}:`;
export const isLeadActorId = (actorId: string): boolean => actorId.startsWith(LEAD_ACTOR_PREFIX);
export const mintLeadActorId = (agentId: number): string => `${LEAD_ACTOR_PREFIX}${agentId}`;
export const LEAD_NAME = LEAD_KIND;
export const isReservedAgentName = (name: string): boolean => name.toLowerCase() === LEAD_NAME;
