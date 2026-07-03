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
    UserRole.ASSISTANT_MANAGER,
    UserRole.TEAM_LEAD, 
    UserRole.STL, 
    UserRole.QTL, 
    UserRole.OPS_TL,
    UserRole.SME, 
    UserRole.TRAINER, 
    UserRole.TRAINER_TL, 
    UserRole.QA, 
    UserRole.AGENT,
    UserRole.OPS_HEAD,
    UserRole.HR,
    UserRole.IT_MANAGER,
  ],
  [UserRole.ASSISTANT_MANAGER]: [
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
  [UserRole.OPS_HEAD]: [
    UserRole.MANAGER,
    UserRole.ASSISTANT_MANAGER,
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
  [UserRole.HR]: [
    UserRole.MANAGER,
    UserRole.ASSISTANT_MANAGER,
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
  [UserRole.IT_MANAGER]: [
    UserRole.MANAGER,
    UserRole.ASSISTANT_MANAGER,
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
  [UserRole.QTL]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.TRAINER_TL]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.TEAM_LEAD]: [UserRole.SME, UserRole.TRAINER, UserRole.QA, UserRole.AGENT],
  [UserRole.QA]: [],
  [UserRole.AGENT]: [],
  [UserRole.MIS]: [],
  [UserRole.SME]: [UserRole.AGENT, UserRole.TRAINER, UserRole.QA],
  [UserRole.TRAINER]: [],
};

export function normalizeRole(role: string | undefined | null): UserRole {
  if (!role) return '' as any;
  const raw = role.toString().toUpperCase().trim().replace(/[\s\-_]+/g, '_');
  if (raw === 'TEAM_LEAD' || raw === 'TEAMLEAD' || raw === 'TEAM_LEADS' || raw === 'TEAM' || raw === 'TEAM_LEADERS' || raw === 'TEAM_LEADER') {
    return UserRole.TEAM_LEAD;
  }
  if (raw === 'TRAINER_TL' || raw === 'TRAINERTL' || raw === 'TRAINER_TEAM_LEAD' || raw === 'TRAINER_TEAM_LEADER') {
    return UserRole.TRAINER_TL;
  }
  if (raw === 'OPS_TL' || raw === 'OPSTL' || raw === 'OPS_TEAM_LEAD' || raw === 'OPS_TEAM_LEADER') {
    return UserRole.OPS_TL;
  }
  if (raw === 'STL') {
    return UserRole.STL;
  }
  if (raw === 'QTL') {
    return UserRole.QTL;
  }
  if (raw === 'ADMIN' || raw === 'ADMINISTRATOR') {
    return UserRole.ADMIN;
  }
  if (raw === 'MANAGER' || raw === 'MANAGERS') {
    return UserRole.MANAGER;
  }
  if (raw === 'ASSISTANT_MANAGER' || raw === 'ASST_MANAGER' || raw === 'ASSISTANTMANAGER' || raw === 'AM') {
    return UserRole.ASSISTANT_MANAGER;
  }
  if (raw === 'OPS_HEAD' || raw === 'OPSHEAD' || raw === 'OPERATIONS_HEAD') {
    return UserRole.OPS_HEAD;
  }
  if (raw === 'HR' || raw === 'HUMAN_RESOURCES') {
    return UserRole.HR;
  }
  if (raw === 'IT_MANAGER' || raw === 'ITMANAGER') {
    return UserRole.IT_MANAGER;
  }
  if (raw === 'QA' || raw === 'QAS' || raw === 'QUALITY_ANALYST') {
    return UserRole.QA;
  }
  if (raw === 'SME' || raw === 'SMES') {
    return UserRole.SME;
  }
  if (raw === 'TRAINER' || raw === 'TRAINERS') {
    return UserRole.TRAINER;
  }
  if (raw === 'AGENT' || raw === 'AGENTS' || raw === 'EMPLOYEE') {
    return UserRole.AGENT;
  }
  if (raw === 'MIS') {
    return UserRole.MIS;
  }
  return raw as UserRole;
}

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

  const actorRole = normalizeRole(actor.role);
  const targetRole = normalizeRole(target.role);

  // 1. Admin bypass
  if (actorRole === UserRole.ADMIN) return true;

  // 2. Check if actor role is allowed to supervise target role
  const subordinates = HIERARCHY_MAP[actorRole] || [];
  const isRoleAuthorized = subordinates.includes(targetRole);

  if (!isRoleAuthorized) return false;

  const actorIdLower = (actor?.uid || '').toLowerCase().trim();
  const actorEmailLower = (actor?.email || '').toLowerCase().trim();
  const actorNameLower = (actor?.name || '').toLowerCase().trim();
  const actorFullNameLower = ((actor?.fullName || actor?.employeeName) || '').toLowerCase().trim();

  // 3. Verify reporting structure (Authoritative Source: Team Mapping fields)
  const isDirectReport = 
    (target?.teamLeadId && target.teamLeadId.toLowerCase().trim() === actorIdLower) ||
    (target?.teamLeadEmail && target.teamLeadEmail.toLowerCase().trim() === actorEmailLower) ||
    (target?.teamLeadId && target.teamLeadId.toLowerCase().trim() === actorEmailLower) ||
    (target?.teamLeadName && actorNameLower && target.teamLeadName.toLowerCase().trim() === actorNameLower) ||
    (target?.teamLeadName && actorFullNameLower && target.teamLeadName.toLowerCase().trim() === actorFullNameLower) ||
    (target?.mappedTL && target.mappedTL.toLowerCase().trim() === actorIdLower) ||
    (target?.teamLeadUid && target.teamLeadUid.toLowerCase().trim() === actorIdLower) ||
    (target?.mappedManagerUid && target.mappedManagerUid.toLowerCase().trim() === actorIdLower) ||
    
    // Manager mappings
    (target?.mappedManagerId && target.mappedManagerId.toLowerCase().trim() === actorIdLower) ||
    (target?.managerId && target.managerId.toLowerCase().trim() === actorIdLower) ||
    (target?.managerEmail && target.managerEmail.toLowerCase().trim() === actorEmailLower) ||
    (target?.mappedManagerEmail && target.mappedManagerEmail.toLowerCase().trim() === actorEmailLower) ||
    (target?.managerName && actorNameLower && target.managerName.toLowerCase().trim() === actorNameLower) ||
    (target?.managerName && actorFullNameLower && target.managerName.toLowerCase().trim() === actorFullNameLower) ||
    (target?.mappedManagerName && actorNameLower && target.mappedManagerName.toLowerCase().trim() === actorNameLower) ||
    (target?.mappedManagerName && actorFullNameLower && target.mappedManagerName.toLowerCase().trim() === actorFullNameLower);
  
  // indirect report check (e.g. Manager -> TL -> Agent)
  const isIndirectReport = allUsers.some(tl => {
    const tlActorIdLower = (tl.mappedManagerId || tl.managerId || '').toLowerCase().trim();
    const tlActorEmailLower = (tl.mappedManagerEmail || tl.managerEmail || '').toLowerCase().trim();
    const tlActorNameLower = (tl.mappedManagerName || tl.managerName || '').toLowerCase().trim();

    const tlIsSubordinate = 
      tlActorIdLower === actorIdLower ||
      tlActorEmailLower === actorEmailLower ||
      (tlActorNameLower && actorNameLower && tlActorNameLower === actorNameLower) ||
      (tlActorNameLower && actorFullNameLower && tlActorNameLower === actorFullNameLower);

    const targetTLIdLower = (target.teamLeadId || '').toLowerCase().trim();
    const targetTLEmailLower = (target.teamLeadEmail || '').toLowerCase().trim();
    const targetTLNameLower = (target.teamLeadName || '').toLowerCase().trim();

    const tlIdLower = (tl.uid || '').toLowerCase().trim();
    const tlEmailLower = (tl.email || '').toLowerCase().trim();
    const tlNameLower = (tl.name || '').toLowerCase().trim();
    const tlFullNameLower = (tl.fullName || tl.employeeName || '').toLowerCase().trim();

    const targetReportsToTL = 
      (targetTLIdLower && targetTLIdLower === tlIdLower) ||
      (targetTLEmailLower && targetTLEmailLower === tlEmailLower) ||
      (targetTLIdLower && targetTLIdLower === tlEmailLower) ||
      (targetTLNameLower && tlNameLower && targetTLNameLower === tlNameLower) ||
      (targetTLNameLower && tlFullNameLower && targetTLNameLower === tlFullNameLower) ||
      (target.mappedTL && target.mappedTL.toLowerCase().trim() === tlIdLower) ||
      (target.teamLeadUid && target.teamLeadUid.toLowerCase().trim() === tlIdLower);

    return tlIsSubordinate && targetReportsToTL;
  });

  // 4. Fallback for sandbox: If no hierarchy is defined in DB
  if (!isDirectReport && !isIndirectReport) {
    const isSandbox = !allUsers.some(u => 
      !!u.teamLeadId || !!u.teamLeadEmail || !!u.teamLeadUid || !!u.mappedTL || 
      !!u.mappedManagerId || !!u.managerId || !!u.teamLeadName || !!u.managerName
    );
    if (isSandbox) return true;
  }

  return !!isDirectReport || isIndirectReport;
}
