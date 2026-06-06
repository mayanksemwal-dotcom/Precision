import { UserProfile, UserRole } from '../types';

/**
 * Hierarchy Logic Engine
 * 
 * Determines who a user (actor) can perform actions on (target) based on 
 * their roles and reporting structure.
 */

// Mapping subordinates based on the request requirements
const HIERARCHY_MAP: Record<UserRole, UserRole[]> = {
  [UserRole.ADMIN]: Object.values(UserRole), // All Users
  [UserRole.MANAGER]: [
    UserRole.TEAM_LEAD, 
    UserRole.STL, 
    UserRole.QTL, 
    UserRole.OPS_TL,
    UserRole.SME, 
    UserRole.TRAINER, 
    UserRole.TRAINER_TL, 
    UserRole.QA, 
    UserRole.AGENT,
  ],
  [UserRole.OPS_TL]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.STL]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.QTL]: [UserRole.QA, UserRole.AGENT],
  [UserRole.TRAINER_TL]: [UserRole.TRAINER, UserRole.AGENT],
  [UserRole.TEAM_LEAD]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.QA]: [],
  [UserRole.AGENT]: [],
  [UserRole.MIS]: [],
  [UserRole.SME]: [],
  [UserRole.TRAINER]: [],
};

/**
 * Checks if the actor has supervisorial authority over the target.
 * authority is true if:
 * 1. Actor is ADMIN
 * 2. Actor's role is a supervisor of target's role AND:
 *    - Target maps directly to actor (actor.uid === target.mappedManagerId or target.teamLeadId)
 *    - OR Target maps indirectly to actor (via a TL who maps to actor)
 * 3. Fallback for sandbox: If no hierarchy is defined in DB (no mappedManagerId or teamLeadId on anybody), 
 *    return true based on role mapping only.
 */
export function canActOn(actor: UserProfile, target: UserProfile, allUsers: UserProfile[] = []): boolean {
  if (!actor || !target) return false;
  if (actor.uid === target.uid) return false; // Usually can't act on self in supervisorial contexts

  const actorRole = actor.role as UserRole;
  const targetRole = target.role as UserRole;

  // 1. Admin bypass
  if (actorRole === UserRole.ADMIN) return true;

  // 2. Check if actor role is allowed to supervise target role
  const subordinates = HIERARCHY_MAP[actorRole] || [];
  const isRoleAuthorized = subordinates.includes(targetRole);

  if (!isRoleAuthorized) return false;

  // 3. Verify reporting structure
  const isDirectReport = target.teamLeadId === actor.uid || target.mappedManagerId === actor.uid;
  
  // indirect report check (e.g. Manager -> TL -> Agent)
  const isIndirectReport = allUsers.some(tl => {
    const tlIsSubordinate = tl.mappedManagerId === actor.uid;
    const targetReportsToTL = target.teamLeadId === tl.uid;
    return tlIsSubordinate && targetReportsToTL;
  });

  // 4. Sandbox/Initial state fallback: 
  // If no hierarchy mappings are defined for ANYONE in the list, allow action based on role mapping only.
  const hasAnyHierarchy = allUsers.some(u => !!u.mappedManagerId || !!u.teamLeadId);
  if (!hasAnyHierarchy) return true;

  return isDirectReport || isIndirectReport;
}
