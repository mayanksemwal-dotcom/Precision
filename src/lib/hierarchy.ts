import { UserProfile, UserRole } from '../types';
import { safeStorage } from './safeStorage';

export interface NormalizedUser extends UserProfile {
  uid: string;
  name: string;
  email: string;
  role: string;
  status: string;
  teamLeadUid: string | null;
  managerUid: string | null;
}

export function normalizeHierarchyUser(u: any): NormalizedUser {
  if (!u) {
    return {
      uid: '',
      name: '',
      email: '',
      role: 'AGENT',
      status: 'Active',
      fullName: '',
      department: 'Operations',
      createdAt: '',
      teamLeadUid: null,
      managerUid: null,
    } as any;
  }
  const uid = u.uid || u.userId || u.employeeId || '';
  const email = (u.email || '').toString().toLowerCase().trim();
  const name = u.fullName || u.name || u.employeeName || '';
  
  // Resolve teamLeadUid canonically across valid ID/UID/Email field variations:
  let teamLeadUid: string | null = null;
  if (u.teamLeadUid && !isPlaceholderValue(u.teamLeadUid)) {
    teamLeadUid = u.teamLeadUid.toString().trim();
  } else if (u.teamLeadId && !isPlaceholderValue(u.teamLeadId)) {
    teamLeadUid = u.teamLeadId.toString().trim();
  } else if (u.tlId && !isPlaceholderValue(u.tlId)) {
    teamLeadUid = u.tlId.toString().trim();
  } else if (u.mappedTL && !isPlaceholderValue(u.mappedTL)) {
    teamLeadUid = u.mappedTL.toString().trim();
  } else if (u.teamLeadEmail && !isPlaceholderValue(u.teamLeadEmail)) {
    teamLeadUid = u.teamLeadEmail.toString().trim();
  }

  // Resolve managerUid canonically across valid ID/UID/Email field variations:
  let managerUid: string | null = null;
  if (u.mappedManagerUid && !isPlaceholderValue(u.mappedManagerUid)) {
    managerUid = u.mappedManagerUid.toString().trim();
  } else if (u.mappedManagerId && !isPlaceholderValue(u.mappedManagerId)) {
    managerUid = u.mappedManagerId.toString().trim();
  } else if (u.managerUid && !isPlaceholderValue(u.managerUid)) {
    managerUid = u.managerUid.toString().trim();
  } else if (u.managerId && !isPlaceholderValue(u.managerId)) {
    managerUid = u.managerId.toString().trim();
  } else if (u.managerEmail && !isPlaceholderValue(u.managerEmail)) {
    managerUid = u.managerEmail.toString().trim();
  } else if (u.mappedManagerEmail && !isPlaceholderValue(u.mappedManagerEmail)) {
    managerUid = u.mappedManagerEmail.toString().trim();
  }

  return {
    ...u,
    uid,
    name,
    fullName: name,
    email,
    role: (u.role || 'AGENT').toString().toUpperCase().trim(),
    status: u.status || 'Active',
    employeeId: u.employeeId || '',
    teamLeadUid,
    managerUid,
    teamLeadName: u.teamLeadName || (u as any).TeamLead || '',
    managerName: u.managerName || u.mappedManagerName || (u as any).Manager || '',
    mappedManagerName: u.mappedManagerName || u.managerName || (u as any).Manager || '',
    // Keep backward-compatible properties
    teamLeadId: teamLeadUid || u.teamLeadId || '',
    managerId: managerUid || u.managerId || '',
    mappedManagerId: managerUid || u.mappedManagerId || '',
    mappedManagerUid: managerUid || u.mappedManagerUid || ''
  };
}

export interface OrgNode {
  uid: string;
  parentUid: string | null;
  children: string[];
  userProfile?: UserProfile;
}

export class OrgTree {
  public nodeMap: Map<string, OrgNode> = new Map();

  constructor(users: UserProfile[] = []) {
    if (users && users.length > 0) {
      this.buildTree(users);
    }
  }

  public buildTree(users: UserProfile[]) {
    this.nodeMap.clear();

    const normalizedUsers = users.map(u => normalizeHierarchyUser(u));

    // Step 1: Initialize nodes
    normalizedUsers.forEach(u => {
      if (!u || !u.uid) return;
      const uid = u.uid;
      this.nodeMap.set(uid, {
        uid,
        parentUid: null,
        children: [],
        userProfile: u
      });
    });

    const lookupMaps = buildAuthoritativeLookupMaps(users);

    // Step 2: Establish parent-child relationships
    normalizedUsers.forEach(u => {
      if (!u || !u.uid) return;
      const uid = u.uid;
      const node = this.nodeMap.get(uid);
      if (!node) return;

      const rawTl = u.teamLeadUid || u.teamLeadId || u.tlId || u.teamLeadEmail || u.teamLeadName || u.mappedTL || (u as any).TeamLead;
      const rawMgr = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId || u.managerEmail || u.mappedManagerEmail || u.managerName || u.mappedManagerName || (u as any).Manager;

      const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
      const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

      // 1. Direct link to TL if resolved
      if (resolvedTLUid && resolvedTLUid !== uid && this.nodeMap.has(resolvedTLUid)) {
        node.parentUid = resolvedTLUid;
        const tlNode = this.nodeMap.get(resolvedTLUid)!;
        if (!tlNode.children.includes(uid)) {
          tlNode.children.push(uid);
        }

        // If TL does not have a parent yet and agent specifies a manager, link TL -> Manager
        if (resolvedManagerUid && resolvedManagerUid !== resolvedTLUid && this.nodeMap.has(resolvedManagerUid)) {
          const tlNodeObj = this.nodeMap.get(resolvedTLUid)!;
          if (!tlNodeObj.parentUid) {
            tlNodeObj.parentUid = resolvedManagerUid;
            const mgrNode = this.nodeMap.get(resolvedManagerUid)!;
            if (!mgrNode.children.includes(resolvedTLUid)) {
              mgrNode.children.push(resolvedTLUid);
            }
          }
        }
      }

      // 2. Direct link to Manager if resolved
      if (resolvedManagerUid && resolvedManagerUid !== uid && this.nodeMap.has(resolvedManagerUid)) {
        if (!node.parentUid) {
          node.parentUid = resolvedManagerUid;
        }
        const mgrNode = this.nodeMap.get(resolvedManagerUid)!;
        if (!mgrNode.children.includes(uid)) {
          mgrNode.children.push(uid);
        }
      }
    });
  }

  public getDescendants(startUid: string): Set<string> {
    const descendants = new Set<string>();
    const visited = new Set<string>([startUid]);
    const queue = [startUid];

    let head = 0;
    while (head < queue.length) {
      const currentUid = queue[head++];
      const node = this.nodeMap.get(currentUid);
      if (node) {
        for (const childUid of node.children) {
          if (!visited.has(childUid)) {
            visited.add(childUid);
            descendants.add(childUid);
            queue.push(childUid);
          }
        }
      }
    }

    return descendants;
  }

  public getAncestors(startUid: string): string[] {
    const ancestors: string[] = [];
    const visited = new Set<string>([startUid]);
    let currentUid: string | null = startUid;

    while (currentUid) {
      const node = this.nodeMap.get(currentUid);
      if (!node || !node.parentUid) break;
      const parentUid = node.parentUid;
      if (visited.has(parentUid)) break; // Prevent infinite loops in case of cycle
      visited.add(parentUid);
      ancestors.push(parentUid);
      currentUid = parentUid;
    }

    return ancestors;
  }

  public updateUserParent(uid: string, newParentUid: string | null) {
    const node = this.nodeMap.get(uid);
    if (!node) return;

    if (node.parentUid && this.nodeMap.has(node.parentUid)) {
      const oldParent = this.nodeMap.get(node.parentUid)!;
      oldParent.children = oldParent.children.filter(c => c !== uid);
    }

    node.parentUid = newParentUid;
    if (newParentUid && this.nodeMap.has(newParentUid)) {
      const newParent = this.nodeMap.get(newParentUid)!;
      if (!newParent.children.includes(uid)) {
        newParent.children.push(uid);
      }
    }
  }

  public getNode(uid: string): OrgNode | undefined {
    return this.nodeMap.get(uid);
  }

  public canSee(actorUid: string, targetUid: string, actorRole?: string): boolean {
    if (actorUid === targetUid) return true;
    const descendants = this.getDescendants(actorUid);
    return descendants.has(targetUid);
  }
}

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
    // 1. Get ID/Email fields ONLY to guarantee accurate matching
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
      u.mappedTL
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

    return [];
  };

  let currentLevel = [target];

  for (let depth = 0; depth < 25; depth++) {
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
export function getSubordinateUids(supervisor: UserProfile, allUsers: UserProfile[], strictlyMappedOnly = false): string[] {
  if (!supervisor || !allUsers || allUsers.length === 0) return [];

  const roleUpper = (supervisor.role || '').toString().toUpperCase().trim();
  const isGlobal = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP', 'SUPER_ADMIN'].includes(roleUpper);

  if (isGlobal && !strictlyMappedOnly) {
    return allUsers.filter(u => u.uid !== supervisor.uid).map(u => u.uid);
  }

  // Fallback: If no hierarchy is defined anywhere in the whole system (Sandbox mode)
  const isSandbox = !allUsers.some(u => 
    !!u.teamLeadId || !!u.teamLeadEmail || !!u.teamLeadUid || !!u.mappedTL || 
    !!u.mappedManagerId || !!u.managerId || !!u.tlId || !!u.teamLeadName || !!u.mappedManagerName
  );

  if (isSandbox) {
    const actorRole = normalizeRole(supervisor.role);
    const subordinatesRoles = HIERARCHY_MAP[actorRole] || [];
    if (subordinatesRoles.length > 0) {
      const uids = new Set<string>();
      allUsers.forEach(u => {
        if (u.uid !== supervisor.uid && subordinatesRoles.includes(normalizeRole(u.role))) {
          uids.add(u.uid);
        }
      });
      return Array.from(uids);
    }
  }

  const tree = new OrgTree(allUsers);
  
  // Resolve supervisor's start UIDs across canonical UID, auth UID, email, employee ID, and name
  const lookupMaps = buildAuthoritativeLookupMaps(allUsers);
  const startUids = new Set<string>();
  if (supervisor.uid) startUids.add(supervisor.uid);
  if (supervisor.email) {
    const emailNorm = supervisor.email.toLowerCase().trim();
    const emailUid = lookupMaps.uidByEmail.get(emailNorm);
    if (emailUid) startUids.add(emailUid);
  }
  if (supervisor.employeeId) {
    const empNorm = supervisor.employeeId.toLowerCase().trim();
    const empUid = lookupMaps.uidByEmployeeId.get(empNorm);
    if (empUid) startUids.add(empUid);
  }
  const supName = (supervisor.fullName || supervisor.name || '').toLowerCase().trim();
  if (supName) {
    const nameUid = lookupMaps.uidByNormalizedName.get(supName);
    if (nameUid) startUids.add(nameUid);
  }

  const allDescendants = new Set<string>();
  startUids.forEach(uid => {
    const desc = tree.getDescendants(uid);
    desc.forEach(d => allDescendants.add(d));
  });

  // Comprehensive safety check: Also include direct and indirect reports verified by isSupervisorOf
  allUsers.forEach(u => {
    if (u.uid !== supervisor.uid && isSupervisorOf(supervisor, u, allUsers)) {
      allDescendants.add(u.uid);
    }
  });

  return Array.from(allDescendants);
}

/**
 * Retrieves the subordinate UIDs with IndexedDB caching.
 * Keeps cache valid for 5 minutes (300,000 ms) to balance freshness and performance.
 */
export async function getCachedSubordinateUids(supervisor: UserProfile, allUsers: UserProfile[], strictlyMappedOnly = false, hierarchyVersion?: number | string): Promise<string[]> {
  if (!supervisor || !supervisor.uid) return [];
  const roleClean = (supervisor.role || 'AGENT').toString().toUpperCase().trim();
  const vTag = hierarchyVersion ? `_v${hierarchyVersion}` : '_v6';
  const cacheKey = `subordinates_${vTag}_${roleClean}_of_${supervisor.uid.toLowerCase().trim()}${strictlyMappedOnly ? '_strict' : ''}`;
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
  const calculatedUids = getSubordinateUids(supervisor, allUsers, strictlyMappedOnly);
  try {
    await safeStorage.setIndexedDB(cacheKey, calculatedUids);
  } catch (err) {
    console.warn('[getCachedSubordinateUids] Cache write failed:', err);
  }

  return calculatedUids;
}

/**
 * Helper to check if user 'u' is a direct report of supervisor 'sup' using mapping fields.
 */
export function isDirectReport(u: UserProfile, sup: UserProfile): boolean {
  if (!u || !sup || u.uid === sup.uid) return false;

  const supUid = (sup.uid || '').toLowerCase().trim();
  const supEmail = (sup.email || '').toLowerCase().trim();
  const supName = (sup.fullName || sup.name || (sup as any).employeeName || '').toLowerCase().trim();

  // 1. Match by UID fields
  if (supUid) {
    const uTLId = (u.teamLeadId || u.teamLeadUid || u.tlId || '').toLowerCase().trim();
    if (uTLId === supUid) return true;

    const uMgrId = (u.managerId || u.mappedManagerId || u.mappedManagerUid || u.managerUid || (u as any).Manager || '').toLowerCase().trim();
    if (uMgrId === supUid) return true;
  }

  // 2. Match by Email fields
  if (supEmail) {
    const uTLEmail = (u.teamLeadEmail || u.mappedTL || '').toLowerCase().trim();
    if (uTLEmail === supEmail) return true;

    const uMgrEmail = (u.managerEmail || u.mappedManagerEmail || '').toLowerCase().trim();
    if (uMgrEmail === supEmail) return true;
  }

  // 3. Fallback name matching (avoid empty/placeholder names)
  if (supName && supName.length > 2 && !isPlaceholderValue(supName)) {
    const uTLName = (u.teamLeadName || (u as any).TeamLead || '').toLowerCase().trim();
    if (uTLName === supName) return true;

    const uMgrName = (u.managerName || u.mappedManagerName || (u as any).Manager || '').toLowerCase().trim();
    if (uMgrName === supName) return true;
  }

  return false;
}

/**
 * Dedicated scope resolver for the TMS Supervisor Dashboard.
 * Returns the supervisor themselves and all recursive descendants in their reporting tree.
 * Admin and MIS roles retain global visibility.
 */
export function getTmsDashboardTeamUids(supervisor: UserProfile, allUsers: UserProfile[]): Set<string> {
  if (!supervisor || !allUsers || allUsers.length === 0) return new Set();

  const roleUpper = (supervisor.role || '').toString().toUpperCase().trim();
  const isGlobal = ['ADMIN', 'OPS_HEAD', 'MIS', 'HR', 'DIRECTOR', 'VP', 'SUPER_ADMIN'].includes(roleUpper);

  if (isGlobal) {
    return new Set(allUsers.map(u => u.uid));
  }

  const descendants = new Set(getSubordinateUids(supervisor, allUsers, false));

  // Log detailed tree hierarchy resolution for this supervisor to assist trace
  console.group(`[TMS HIERARCHY RESOLVER] Supervisor: ${supervisor.name || supervisor.fullName} (${supervisor.uid})`);
  console.info("Supervisor Role:", supervisor.role);
  console.info("Total Roster Users evaluated:", allUsers.length);
  console.info("Total Descendants computed:", descendants.size);
  if (descendants.size === allUsers.length && allUsers.length > 1) {
    console.info("Info: Descendants count matches input roster size (user is root of this roster).");
  }
  console.groupEnd();

  // Always include the supervisor themselves
  descendants.add(supervisor.uid);

  return descendants;
}

export interface NodeValidationResult {
  uid: string;
  name: string;
  email: string;
  role: string;
  status: 'HEALTHY' | 'ORPHAN' | 'UNMAPPED' | 'CONFLICT' | 'CYCLE' | 'INVALID PARENT' | 'AMBIGUOUS' | 'LEGACY_RAW_REFERENCE' | 'MISSING_CANONICAL_UID';
  message: string;
  details?: string;
}

export interface HierarchyHealthSummary {
  total: number;
  healthy: number;
  orphans: number;
  unmapped: number;
  conflicts: number;
  cycles: number;
  invalidParents: number;
  ambiguous: number;
}

export function buildAuthoritativeLookupMaps(existingRoster: any[], csvRows?: any[]) {
  const uidByUid = new Map<string, string>();
  const uidByEmployeeId = new Map<string, string>();
  const uidByEmail = new Map<string, string>();
  const uidByNormalizedName = new Map<string, string>();
  const ambiguousNames = new Set<string>();

  const allEntries = [...existingRoster];
  if (csvRows) {
    csvRows.forEach(row => {
      const uid = row.uid || row.userId || row.employeeUid || row.employeeId;
      if (uid && !allEntries.some(e => e.uid === uid)) {
        allEntries.push(row);
      }
    });
  }

  // PASS 1: Build canonical map for email -> canonical UID (where UID does not start with local_)
  const emailToCanonicalUid = new Map<string, string>();
  allEntries.forEach(u => {
    if (u.email && !isPlaceholderValue(u.email)) {
      const email = u.email.toString().toLowerCase().trim();
      const uid = u.uid || u.userId || '';
      if (uid && !uid.startsWith('local_')) {
        emailToCanonicalUid.set(email, uid);
      }
    }
  });

  // PASS 2: Map everything, redirecting to canonical UID where possible
  const nameToUids = new Map<string, Set<string>>();

  allEntries.forEach(u => {
    if (!u) return;
    const originalUid = u.uid || u.userId || u.employeeId || '';
    if (!originalUid) return;

    let canonicalUid = originalUid;
    const emailStr = u.email && !isPlaceholderValue(u.email) ? u.email.toString().toLowerCase().trim() : null;
    
    if (emailStr && emailToCanonicalUid.has(emailStr)) {
      canonicalUid = emailToCanonicalUid.get(emailStr)!;
    }

    uidByUid.set(originalUid, canonicalUid);
    if (originalUid !== canonicalUid) {
      uidByUid.set(canonicalUid, canonicalUid);
    }

    if (u.employeeId && !isPlaceholderValue(u.employeeId)) {
      uidByEmployeeId.set(u.employeeId.toString().toLowerCase().trim(), canonicalUid);
    }
    if (emailStr) {
      uidByEmail.set(emailStr, canonicalUid);
    }
    const name = u.fullName || u.name || u.employeeName || '';
    if (name && !isPlaceholderValue(name)) {
      const normName = name.toString().toLowerCase().trim();
      if (!nameToUids.has(normName)) {
        nameToUids.set(normName, new Set());
      }
      nameToUids.get(normName)!.add(canonicalUid);
    }
  });

  nameToUids.forEach((uids, normName) => {
    if (uids.size === 1) {
      uidByNormalizedName.set(normName, Array.from(uids)[0]);
    } else {
      ambiguousNames.add(normName);
    }
  });

  return { uidByUid, uidByEmployeeId, uidByEmail, uidByNormalizedName, ambiguousNames };
}

export function normalizeHierarchyReference(
  val: any,
  maps: {
    uidByUid: Map<string, string>;
    uidByEmployeeId: Map<string, string>;
    uidByEmail: Map<string, string>;
    uidByNormalizedName: Map<string, string>;
    ambiguousNames?: Set<string>;
  }
): string | null {
  if (!val || isPlaceholderValue(val)) return null;
  const str = val.toString().trim();
  const lowerStr = str.toLowerCase();

  if (maps.uidByUid.has(str)) {
    return maps.uidByUid.get(str)!;
  }
  if (maps.uidByEmployeeId.has(lowerStr)) {
    return maps.uidByEmployeeId.get(lowerStr)!;
  }
  if (maps.uidByEmail.has(lowerStr)) {
    return maps.uidByEmail.get(lowerStr)!;
  }
  if (maps.uidByNormalizedName.has(lowerStr)) {
    return maps.uidByNormalizedName.get(lowerStr)!;
  }

  return null;
}

export function getHierarchyPersistencePayload(params: {
  userUid: string;
  teamLeadUid: string | null;
  managerUid: string | null;
  allUsers: any[];
}) {
  const { userUid, teamLeadUid, managerUid, allUsers } = params;

  const lookup = new Map<string, any>();
  allUsers.forEach(u => lookup.set(u.uid, u));

  const tl = teamLeadUid ? lookup.get(teamLeadUid) : null;
  const mgr = managerUid ? lookup.get(managerUid) : null;

  return {
    teamLeadUid: teamLeadUid || '',
    managerUid: managerUid || '',
    mappedManagerUid: managerUid || '',

    teamLeadId: teamLeadUid || '',
    managerId: managerUid || '',
    mappedManagerId: managerUid || '',

    teamLeadName: tl ? (tl.fullName || tl.name || tl.employeeName || '') : '',
    teamLeadEmail: tl ? (tl.email || '') : '',
    managerName: mgr ? (mgr.fullName || mgr.name || mgr.employeeName || '') : '',
    managerEmail: mgr ? (mgr.email || '') : '',
    mappedManagerName: mgr ? (mgr.fullName || mgr.name || mgr.employeeName || '') : '',
    mappedManagerEmail: mgr ? (mgr.email || '') : ''
  };
}

export function validateHierarchy(users: UserProfile[]): {
  results: Map<string, NodeValidationResult>;
  summary: HierarchyHealthSummary;
} {
  const results = new Map<string, NodeValidationResult>();
  const summary: HierarchyHealthSummary = {
    total: users.length,
    healthy: 0,
    orphans: 0,
    unmapped: 0,
    conflicts: 0,
    cycles: 0,
    invalidParents: 0,
    ambiguous: 0
  };

  const lookupMaps = buildAuthoritativeLookupMaps(users);

  const profilesMap = new Map<string, any>();
  users.forEach(u => {
    profilesMap.set(u.uid, u);
  });

  const detectCycle = (startUid: string): boolean => {
    const visited = new Set<string>();
    let curr: string | null = startUid;
    while (curr) {
      if (visited.has(curr)) return true;
      visited.add(curr);
      const user = profilesMap.get(curr);
      if (!user) break;

      const rawTl = user.teamLeadUid || user.teamLeadId || user.tlId;
      const tlUid = normalizeHierarchyReference(rawTl, lookupMaps);
      
      const rawMgr = user.mappedManagerUid || user.mappedManagerId || user.managerUid || user.managerId;
      const mgrUid = normalizeHierarchyReference(rawMgr, lookupMaps);

      curr = tlUid || mgrUid || null;
    }
    return false;
  };

  users.forEach(u => {
    const uid = u.uid;
    let status: NodeValidationResult['status'] = 'HEALTHY';
    let message = 'All reporting structures are fully consistent.';
    let details = '';

    const rawTl = u.teamLeadUid || u.teamLeadId || u.tlId;
    const rawMgr = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId;

    const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
    const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

    const hasMissingCanonicalUid = 
      (rawTl && !isPlaceholderValue(rawTl) && !u.teamLeadUid) ||
      (rawMgr && !isPlaceholderValue(rawMgr) && !u.mappedManagerUid && !u.managerUid);

    const hasLegacyRawTL = rawTl && !isPlaceholderValue(rawTl) && !lookupMaps.uidByUid.has(rawTl.toString().trim());
    const hasLegacyRawMgr = rawMgr && !isPlaceholderValue(rawMgr) && !lookupMaps.uidByUid.has(rawMgr.toString().trim());
    const hasLegacyRawReference = hasLegacyRawTL || hasLegacyRawMgr;

    if (detectCycle(uid)) {
      status = 'CYCLE';
      message = 'Reporting cycle detected! This user reports back to themselves through a loop.';
      details = `Path loops back. Check reporting lines for ${u.name || u.fullName}.`;
    }
    else if (rawTl && !isPlaceholderValue(rawTl) && !resolvedTLUid) {
      status = 'ORPHAN';
      message = `Orphaned relationship! Team Lead "${rawTl}" could not be resolved to any active employee.`;
      details = `The user reports to an invalid, unresolvable, or deleted Team Lead.`;
    }
    else if (rawMgr && !isPlaceholderValue(rawMgr) && !resolvedManagerUid) {
      status = 'INVALID PARENT';
      message = `Invalid parent! Manager "${rawMgr}" could not be resolved to any active employee.`;
      details = `The user has an invalid, unresolvable, or deleted Manager reference.`;
    }
    else if (!resolvedTLUid && !resolvedManagerUid) {
      const roleUpper = (u.role || 'AGENT').toString().toUpperCase().trim();
      const topRoles = ['ADMIN', 'OPS_HEAD', 'MANAGER', 'HR', 'DIRECTOR', 'VP'];
      const isTopRole = topRoles.includes(roleUpper);
      if (!isTopRole) {
        status = 'UNMAPPED';
        message = 'Missing parent! This user has no designated supervisor or manager.';
        details = 'Requires an active reporting assignment (Team Lead or Manager) to be visible.';
      }
    }
    else if (u.teamLeadEmail && !isPlaceholderValue(u.teamLeadEmail)) {
      const emailLower = u.teamLeadEmail.toLowerCase().trim();
      const resolvedByEmail = lookupMaps.uidByEmail.get(emailLower);
      if (resolvedByEmail && resolvedTLUid && resolvedByEmail !== resolvedTLUid) {
        status = 'CONFLICT';
        message = 'Relationship conflict! Team Lead UID and Team Lead Email point to different users.';
        details = `UID resolves to ${profilesMap.get(resolvedTLUid)?.name || resolvedTLUid}, but email points to ${profilesMap.get(resolvedByEmail)?.name || resolvedByEmail}.`;
      }
    }

    if (status === 'HEALTHY') {
      if (hasLegacyRawReference) {
        status = 'LEGACY_RAW_REFERENCE';
        message = 'Legacy raw text mapping! Reporting line uses name/email instead of canonical UID.';
        details = 'Will cause querying/traversal failures. Run repair to canonicalize relationships.';
      } else if (hasMissingCanonicalUid) {
        status = 'MISSING_CANONICAL_UID';
        message = 'Missing canonical UID fields! Fields teamLeadUid or managerUid are empty in Firestore.';
        details = 'Requires a rebuild to populate canonical indexing fields.';
      }
    }

    results.set(uid, {
      uid,
      name: u.name || u.fullName || u.employeeName || '',
      email: u.email || '',
      role: u.role || 'AGENT',
      status,
      message,
      details
    });

    if (status === 'HEALTHY') summary.healthy++;
    else if (status === 'ORPHAN') summary.orphans++;
    else if (status === 'UNMAPPED') summary.unmapped++;
    else if (status === 'CONFLICT') summary.conflicts++;
    else if (status === 'CYCLE') summary.cycles++;
    else if (status === 'INVALID PARENT') summary.invalidParents++;
    else if (status === 'LEGACY_RAW_REFERENCE') summary.ambiguous++;
    else if (status === 'MISSING_CANONICAL_UID') summary.ambiguous++;
  });

  return { results, summary };
}

/**
 * Resolves the canonical Team Lead and Manager names and UIDs for any given employee.
 * Uses canonical UID/mapping relationships and authoritative lookup maps.
 * Matches the hierarchy currently displayed in TMS / User Directory.
 */
export function resolveAuthoritativeHierarchy(
  user: UserProfile | null | undefined,
  allUsers: UserProfile[] = [],
  cachedLookupMaps?: {
    uidByUid: Map<string, string>;
    uidByEmployeeId: Map<string, string>;
    uidByEmail: Map<string, string>;
    uidByNormalizedName: Map<string, string>;
    ambiguousNames?: Set<string>;
  }
): {
  teamLead: string;
  manager: string;
  teamLeadUid: string | null;
  managerUid: string | null;
} {
  if (!user) {
    return {
      teamLead: 'Unassigned',
      manager: 'Unassigned',
      teamLeadUid: null,
      managerUid: null,
    };
  }

  const lookupMaps = cachedLookupMaps || buildAuthoritativeLookupMaps(allUsers);
  const usersByUid = new Map<string, UserProfile>();
  allUsers.forEach(u => {
    if (u.uid) usersByUid.set(u.uid, u);
  });

  // 1. Resolve Team Lead
  const rawTl = user.teamLeadUid || user.teamLeadId || user.tlId || user.teamLeadEmail || user.teamLeadName || (user as any).TeamLead;
  const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
  
  let teamLeadName = 'Unassigned';
  let teamLeadUid: string | null = null;
  let tlUser: UserProfile | undefined = undefined;

  if (resolvedTLUid && resolvedTLUid !== user.uid) {
    tlUser = usersByUid.get(resolvedTLUid);
    if (tlUser) {
      teamLeadName = tlUser.fullName || tlUser.name || tlUser.employeeName || tlUser.email || 'Unassigned';
      teamLeadUid = tlUser.uid;
    }
  }

  // Fallback for team lead name if not resolved to active UID but user has non-placeholder string
  if (teamLeadName === 'Unassigned' && user.teamLeadName && !isPlaceholderValue(user.teamLeadName)) {
    teamLeadName = user.teamLeadName.trim();
  }

  // 2. Resolve Manager
  const rawMgr = user.mappedManagerUid || user.mappedManagerId || user.managerUid || user.managerId || user.mappedManagerEmail || user.managerEmail || user.mappedManagerName || user.managerName || (user as any).Manager;
  let resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

  // If no direct manager mapped on employee, but employee has a Team Lead, check if Team Lead has a manager
  if (!resolvedManagerUid && tlUser) {
    const rawTlMgr = tlUser.mappedManagerUid || tlUser.mappedManagerId || tlUser.managerUid || tlUser.managerId || tlUser.mappedManagerEmail || tlUser.managerEmail || tlUser.mappedManagerName || tlUser.managerName || (tlUser as any).Manager;
    resolvedManagerUid = normalizeHierarchyReference(rawTlMgr, lookupMaps);
  }

  let managerName = 'Unassigned';
  let managerUid: string | null = null;

  if (resolvedManagerUid && resolvedManagerUid !== user.uid) {
    const mgrUser = usersByUid.get(resolvedManagerUid);
    if (mgrUser) {
      managerName = mgrUser.fullName || mgrUser.name || mgrUser.employeeName || mgrUser.email || 'Unassigned';
      managerUid = mgrUser.uid;
    }
  }

  return {
    teamLead: teamLeadName,
    manager: managerName,
    teamLeadUid,
    managerUid,
  };
}

