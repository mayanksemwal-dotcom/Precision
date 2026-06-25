import { db } from './firebase';
import { collection, doc, getDocs, writeBatch, query, where } from 'firebase/firestore';
import { UserRole } from '../types';

export interface DiagnosticResult {
  missingRoles: string[];
  invalidRoleUsers: string[];
  missingPermissionsRoles: string[];
  reportLogs: string[];
}

export const runPermissionDiagnostic = async (): Promise<DiagnosticResult> => {
  const result: DiagnosticResult = {
    missingRoles: [],
    invalidRoleUsers: [],
    missingPermissionsRoles: [],
    reportLogs: []
  };

  try {
    // 1. Check Roles
    const rolesSnap = await getDocs(collection(db, 'roles'));
    const existingRoleNames = rolesSnap.docs.map(d => d.id);
    const expectedRoles = Object.values(UserRole);

    expectedRoles.forEach(role => {
      if (!existingRoleNames.includes(role)) {
        result.missingRoles.push(role);
      }
    });

    // 2. Check Users
    const usersSnap = await getDocs(collection(db, 'users'));
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (!expectedRoles.includes(u.role)) {
        result.invalidRoleUsers.push(`${u.email || u.uid} (Role: ${u.role})`);
      }
    });

    // 3. Check Permissions
    const permSnap = await getDocs(collection(db, 'role_permissions'));
    const rolesWithPerms = new Set(permSnap.docs.map(d => d.data().role_name));

    expectedRoles.forEach(role => {
      if (!rolesWithPerms.has(role)) {
        result.missingPermissionsRoles.push(role);
      }
    });

    result.reportLogs.push(`Diagnostic Complete. Found ${result.missingRoles.length} missing roles and ${result.missingPermissionsRoles.length} roles without permissions.`);
  } catch (err: any) {
    result.reportLogs.push(`Diagnostic Failed: ${err.message}`);
  }

  return result;
};

export const performPermissionRecovery = async () => {
  const now = new Date().toISOString();
  let opsCount = 0;
  let batch = writeBatch(db);

  const commitBatch = async () => {
    if (opsCount > 0) {
      await batch.commit();
      batch = writeBatch(db);
      opsCount = 0;
    }
  };

  const addOp = async () => {
    opsCount++;
    if (opsCount >= 450) {
      await commitBatch();
    }
  };

  // 1. Roles
  const roles = [
    'ADMIN', 'Manager', 'Team_Lead', 'QA', 'Agent', 'SME', 'Ops_TL', 'STL', 'QTL', 'Trainer', 'Trainer_TL', 'MIS'
  ];

  for (const role of roles) {
    batch.set(doc(db, 'roles', role), {
      id: role,
      name: role,
      description: `Default system role for ${role}`,
      createdAt: now
    }, { merge: true });
    await addOp();
  }

  // Upper Roles
  const upperRoles = roles.map(r => r.toUpperCase());
  for (const role of upperRoles) {
    if (!roles.includes(role)) {
       batch.set(doc(db, 'roles', role), {
        id: role,
        name: role,
        description: `Default system role for ${role}`,
        createdAt: now
      }, { merge: true });
      await addOp();
    }
  }

  // 2. Role Permissions
  const modules = [
    'Workforce TMS', 'KPI Scorecard', 'Warnings', 'PIP Management', 'Historical Records', 'Important Quality Links', 'Console'
  ];

  const allRoleKeys = Array.from(new Set([...roles, ...upperRoles]));

  for (const role of allRoleKeys) {
    for (const mod of modules) {
      const permId = `${role}_${mod}`;
      const docRef = doc(db, 'role_permissions', permId);
      
      let perms = {
        role_name: role,
        module_name: mod,
        can_view: false,
        can_create: false,
        can_edit: false,
        can_delete: false,
        can_export: false,
        can_approve: false
      };

      const upperRole = role.toUpperCase();

      if (upperRole === 'ADMIN') {
        perms = { ...perms, can_view: true, can_create: true, can_edit: true, can_delete: true, can_export: true, can_approve: true };
      } 
      else if (['MANAGER', 'OPS_TL', 'STL', 'TRAINER_TL', 'MIS'].includes(upperRole)) {
        perms.can_view = true;
        perms.can_export = true;
        perms.can_approve = true;
        if (mod !== 'Console') {
            perms.can_create = true;
            perms.can_edit = true;
        } else if (upperRole === 'MANAGER') {
            perms.can_view = true;
        }
      }
      else if (['TEAM_LEAD', 'QTL', 'QA', 'SME', 'TRAINER'].includes(upperRole)) {
        perms.can_view = true;
        if (mod === 'Warnings' || mod === 'PIP Management' || mod === 'Workforce TMS' || mod === 'KPI Scorecard') {
            perms.can_create = true;
            perms.can_edit = true;
            perms.can_approve = true;
        }
      }
      else if (upperRole === 'AGENT') {
        if (mod === 'Workforce TMS' || mod === 'KPI Scorecard' || mod === 'Warnings' || mod === 'PIP Management' || mod === 'Important Quality Links') {
            perms.can_view = true;
        }
      }

      batch.set(docRef, perms, { merge: true });
      await addOp();
    }
  }

  // 3. Sync Employee Master
  const usersSnap = await getDocs(collection(db, 'users'));
  for (const uDoc of usersSnap.docs) {
    const u = uDoc.data();
    const masterData = {
      employeeId: u.employeeId || '',
      employeeName: u.fullName || u.name || '',
      email: u.email || '',
      role: u.role || '',
      department: u.department || 'Operations',
      process: u.process || '',
      teamLeadId: u.teamLeadId || '',
      teamLeadName: u.teamLeadName || '',
      managerId: u.mappedManagerId || '',
      managerName: u.mappedManagerName || '',
      status: u.status || 'Active',
      dateJoined: u.dateJoined || '',
      lastUpdated: now
    };
    batch.set(doc(db, 'employee_master', uDoc.id), masterData, { merge: true });
    await addOp();
  }

  await commitBatch();
};
