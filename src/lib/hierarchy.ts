import { UserProfile, UserRole } from '../types';
import { safeStorage } from './safeStorage';

/**
 * Helper to identify placeholder/empty values that should not be used in matches or BFS mapping.
 */
export function isPlaceholderValue(val: any): boolean {
  if (val === null || val === undefined) return true;
  const str = val.toString().toLowerCase().trim();
  return (
    !str ||
    str === 'n/a' ||
    str === 'none' ||
    str === 'undefined' ||
    str === 'null' ||
    str === '-' ||
    str === 'no' ||
    str === 'unassigned' ||
    str === 'not assigned' ||
    str === 'false' ||
    str === 'true' ||
    str === '0' ||
    str.length < 3
  );
}

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
  if (
    raw === 'TEAM_LEAD' || 
    raw === 'TEAMLEAD' || 
    raw === 'TEAM_LEADS' || 
    raw === 'TEAM' || 
    raw === 'TEAM_LEADERS' || 
    raw === 'TEAM_LEADER' || 
    raw === 'STL' || 
    raw === 'QTL' || 
    raw === 'OPS_TL' || 
    raw === 'TRAINER_TL' || 
    raw.endsWith('_TL') ||
    raw.endsWith(' TL') ||
    raw === 'TEAM_LEAD_STANDARD'
  ) {
    return UserRole.TEAM_LEAD;
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
export function isSupervisorOf(actor: UserProfile, target: UserProfile, allUsers: UserProfile[] = []): boolean {
  if (!actor || !target) return false;
  if (actor.uid === target.uid) return false;

  const actorUid = isPlaceholderValue(actor.uid) ? '' : (actor.uid || '').toLowerCase().trim();
  const actorEmpId = isPlaceholderValue(actor.employeeId) ? '' : (actor.employeeId || '').toLowerCase().trim();
  const actorEmail = isPlaceholderValue(actor.email) ? '' : (actor.email || '').toLowerCase().trim();
  const actorName = isPlaceholderValue(actor.fullName || actor.name || (actor as any).employeeName) 
    ? '' : (actor.fullName || actor.name || (actor as any).employeeName || '').toLowerCase().trim();

  if (!actorUid && !actorEmpId && !actorEmail && !actorName) return false;

  const visited = new Set<string>();

  const getSupervisorKeys = (u: UserProfile): string[] => {
    // 1. Try to get ID/Email fields first to guarantee unique matching
    const ids = new Set<string>();
    const idFields = [
      u.teamLeadId,
      u.teamLeadUid,
      u.tlId,
      u.managerId,
      u.mappedManagerId,
      u.mappedManagerUid,
      u.managerUid,
      u.teamLeadEmail,
      u.managerEmail,
      u.mappedManagerEmail,
      u.mappedTL,
      (u as any).Manager
    ];
    idFields.forEach(f => {
      if (f) {
        const val = f.toString().toLowerCase().trim();
        if (val && !isPlaceholderValue(val)) {
          ids.add(val);
        }
      }
    });

    if (ids.size > 0) {
      return Array.from(ids);
    }

    // 2. Fall back to name fields ONLY if no ID/Email fields are present on this user profile
    const names = new Set<string>();
    const nameFields = [
      u.teamLeadName,
      u.managerName,
      u.mappedManagerName,
      u.mappedTL,
      (u as any).Manager,
      (u as any).TeamLead,
      (u as any).mappedManager
    ];
    nameFields.forEach(f => {
      if (f) {
        const val = f.toString().toLowerCase().trim();
        if (val && !isPlaceholderValue(val)) {
          if (!val.includes('@') && val.length > 2) {
            names.add(val);
          }
        }
      }
    });

    return Array.from(names);
  };

  let currentLevel = [target];

  for (let depth = 0; depth < 10; depth++) {
    const nextLevel: UserProfile[] = [];
    const supervisorKeysForNext = new Set<string>();

    for (const curr of currentLevel) {
      const sups = getSupervisorKeys(curr);
      for (const supId of sups) {
        if (
          (actorUid && supId === actorUid) ||
          (actorEmpId && supId === actorEmpId) ||
          (actorEmail && supId === actorEmail) ||
          (actorName && supId === actorName)
        ) {
          return true;
        }
        if (supId) {
          supervisorKeysForNext.add(supId);
        }
      }
    }

    if (supervisorKeysForNext.size === 0) break;

    allUsers.forEach(u => {
      const uUid = isPlaceholderValue(u.uid) ? '' : (u.uid || '').toLowerCase().trim();
      const uEmpId = isPlaceholderValue(u.employeeId) ? '' : (u.employeeId || '').toLowerCase().trim();
      const uEmail = isPlaceholderValue(u.email) ? '' : (u.email || '').toLowerCase().trim();
      const uName = isPlaceholderValue(u.fullName || u.name || (u as any).employeeName) 
        ? '' : (u.fullName || u.name || (u as any).employeeName || '').toLowerCase().trim();

      if (uUid && supervisorKeysForNext.has(uUid)) {
        if (!visited.has(uUid)) {
          visited.add(uUid);
          nextLevel.push(u);
        }
      } else if (uEmpId && supervisorKeysForNext.has(uEmpId)) {
        if (!visited.has(uEmpId)) {
          visited.add(uEmpId);
          nextLevel.push(u);
        }
      } else if (uEmail && supervisorKeysForNext.has(uEmail)) {
        if (!visited.has(uEmail)) {
          visited.add(uEmail);
          nextLevel.push(u);
        }
      } else if (uName && supervisorKeysForNext.has(uName)) {
        if (!visited.has(uName)) {
          visited.add(uName);
          nextLevel.push(u);
        }
      }
    });

    if (nextLevel.length === 0) break;
    currentLevel = nextLevel;
  }

  return false;
}

/**
 * Checks if the actor has supervisorial authority over the target.
 * Strictly enforced based on direct & indirect reporting hierarchy.
 */
export function canActOn(actor: UserProfile, target: UserProfile, allUsers: UserProfile[] = []): boolean {
  if (!actor || !target) return false;
  if (actor.uid === target.uid) return true;

  // Direct & Indirect reporting structure via IDs, Emails, or Names
  if (isSupervisorOf(actor, target, allUsers)) return true;

  // Fallback: If no hierarchy is defined anywhere in the whole system (Sandbox mode)
  const isSandbox = !allUsers.some(u => 
    !!u.teamLeadId || !!u.teamLeadEmail || !!u.teamLeadUid || !!u.mappedTL || 
    !!u.mappedManagerId || !!u.managerId || !!u.tlId || !!u.teamLeadName || !!u.mappedManagerName
  );
  if (isSandbox) {
    const actorRole = normalizeRole(actor.role);
    const targetRole = normalizeRole(target.role);
    const subordinates = HIERARCHY_MAP[actorRole] || [];
    return subordinates.includes(targetRole);
  }

  return false;
}

/**
 * Recursively builds an array of subordinate UIDs (direct and indirect reportees)
 * for a given supervisor in a single efficient BFS pass.
 */
export function getSubordinateUids(supervisor: UserProfile, allUsers: UserProfile[]): string[] {
  if (!supervisor || !allUsers || allUsers.length === 0) return [];
  const normRole = (supervisor.role || '').toString().toUpperCase().trim();
  const checkIsGlobalRole = (r: string) => {
    const upper = r.toUpperCase().trim();
    const globals = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP'];
    return globals.some(g => upper.includes(g));
  };

  if (checkIsGlobalRole(normRole)) {
    return allUsers.map(u => u.uid).filter(Boolean);
  }

  const supervisorUid = isPlaceholderValue(supervisor.uid) ? '' : (supervisor.uid || '').toLowerCase().trim();
  const supervisorEmpId = isPlaceholderValue(supervisor.employeeId) ? '' : (supervisor.employeeId || '').toLowerCase().trim();
  const supervisorEmail = isPlaceholderValue(supervisor.email) ? '' : (supervisor.email || '').toLowerCase().trim();
  const supervisorName = isPlaceholderValue(supervisor.fullName || supervisor.name || (supervisor as any).employeeName) 
    ? '' : (supervisor.fullName || supervisor.name || (supervisor as any).employeeName || '').toLowerCase().trim();

  if (!supervisorUid && !supervisorEmpId && !supervisorEmail && !supervisorName) return [];

  const parentToChildrenMap = new Map<string, UserProfile[]>();

  const getSupervisorKeys = (u: UserProfile): string[] => {
    // 1. Try to get ID/Email fields first to guarantee unique matching
    const ids = new Set<string>();
    const idFields = [
      u.teamLeadId,
      u.teamLeadUid,
      u.tlId,
      u.managerId,
      u.mappedManagerId,
      u.mappedManagerUid,
      u.managerUid,
      u.teamLeadEmail,
      u.managerEmail,
      u.mappedManagerEmail,
      u.mappedTL,
      (u as any).Manager
    ];
    idFields.forEach(f => {
      if (f) {
        const val = f.toString().toLowerCase().trim();
        if (val && !isPlaceholderValue(val)) {
          ids.add(val);
        }
      }
    });

    if (ids.size > 0) {
      return Array.from(ids);
    }

    // 2. Fall back to name fields ONLY if no ID/Email fields are present on this user profile
    const names = new Set<string>();
    const nameFields = [
      u.teamLeadName,
      u.managerName,
      u.mappedManagerName,
      u.mappedTL,
      (u as any).Manager,
      (u as any).TeamLead,
      (u as any).mappedManager
    ];
    nameFields.forEach(f => {
      if (f) {
        const val = f.toString().toLowerCase().trim();
        if (val && !isPlaceholderValue(val)) {
          if (!val.includes('@') && val.length > 2) {
            names.add(val);
          }
        }
      }
    });

    return Array.from(names);
  };

  // Build mapping from supervisor ID to child profiles
  for (const u of allUsers) {
    if (u.uid === supervisor.uid) continue;
    const sups = getSupervisorKeys(u);
    for (const sup of sups) {
      if (!parentToChildrenMap.has(sup)) {
        parentToChildrenMap.set(sup, []);
      }
      parentToChildrenMap.get(sup)!.push(u);
    }
  }

  const subordinates = new Set<string>();
  const queue: UserProfile[] = [];

  const startingKeys = [supervisorUid, supervisorEmpId, supervisorEmail, supervisorName].filter(k => k && !isPlaceholderValue(k));
  for (const key of startingKeys) {
    const directReports = parentToChildrenMap.get(key);
    if (directReports) {
      for (const dr of directReports) {
        if (dr.uid && !subordinates.has(dr.uid)) {
          subordinates.add(dr.uid);
          queue.push(dr);
        }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentUid = isPlaceholderValue(current.uid) ? '' : (current.uid || '').toLowerCase().trim();
    const currentEmpId = isPlaceholderValue(current.employeeId) ? '' : (current.employeeId || '').toLowerCase().trim();
    const currentEmail = isPlaceholderValue(current.email) ? '' : (current.email || '').toLowerCase().trim();
    const currentName = isPlaceholderValue(current.fullName || current.name || (current as any).employeeName) 
      ? '' : (current.fullName || current.name || (current as any).employeeName || '').toLowerCase().trim();

    const keys = [currentUid, currentEmpId, currentEmail, currentName].filter(k => k && !isPlaceholderValue(k));
    for (const key of keys) {
      const children = parentToChildrenMap.get(key);
      if (children) {
        for (const child of children) {
          if (child.uid && !subordinates.has(child.uid)) {
            subordinates.add(child.uid);
            queue.push(child);
          }
        }
      }
    }
  }

  return Array.from(subordinates);
}

/**
 * Retrieves the subordinate UIDs with IndexedDB caching.
 * Keeps cache valid for 5 minutes (300,000 ms) to balance freshness and performance.
 */
export async function getCachedSubordinateUids(supervisor: UserProfile, allUsers: UserProfile[]): Promise<string[]> {
  if (!supervisor || !supervisor.uid) return [];
  const roleClean = (supervisor.role || 'AGENT').toString().toUpperCase().trim();
  const cacheKey = `subordinates_v3_${roleClean}_of_${supervisor.uid.toLowerCase().trim()}`;
  const TTL_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const cached = await safeStorage.getIndexedDB<string[]>(cacheKey, TTL_MS);
    if (cached && Array.isArray(cached)) {
      return cached;
    }
  } catch (err) {
    console.warn('[getCachedSubordinateUids] Cache read failed, falling back to live calculation:', err);
  }

  // Calculate and store
  const calculatedUids = getSubordinateUids(supervisor, allUsers);
  try {
    await safeStorage.setIndexedDB(cacheKey, calculatedUids);
  } catch (err) {
    console.warn('[getCachedSubordinateUids] Cache write failed:', err);
  }

  return calculatedUids;
}
