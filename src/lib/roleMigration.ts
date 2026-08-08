import { 
  collection, 
  getDocs, 
  doc, 
  setDoc, 
  writeBatch,
  getDoc
} from 'firebase/firestore';
import { db } from './firebase';

export interface MigrationReport {
  usersMigrated: number;
  oldRolesFound: string[];
  newRole: string;
  filesModified: string[];
  permissionsUpdated: string[];
}

export async function runRoleStandardizationMigration(): Promise<MigrationReport | null> {
  const report: MigrationReport = {
    usersMigrated: 0,
    oldRolesFound: [],
    newRole: 'Team Lead',
    filesModified: [
      '/src/types/index.ts',
      '/src/lib/hierarchy.ts',
      '/src/lib/roles.ts',
      '/src/lib/permissionRecovery.ts',
      '/src/components/PermissionContext.tsx',
      '/src/components/admin/RolePermissionSubView.tsx',
      '/src/components/admin/UserManagementSubView.tsx',
      '/src/components/admin/TeamProcessMappingSubView.tsx',
      '/src/components/admin/DashboardSubView.tsx',
      '/src/components/attendance/AttendanceDashboard.tsx',
      '/src/components/tms/SupervisorDashboard.tsx',
      '/src/components/tms/useLiveShifts.ts',
      '/src/views/TMSView.tsx',
      '/src/views/ResourceHubView.tsx',
      '/src/App.tsx'
    ],
    permissionsUpdated: []
  };

  try {
    const lockRef = doc(db, 'config', 'role_standardization_lock');
    const lockSnap = await getDoc(lockRef);
    if (lockSnap.exists() && lockSnap.data()?.completed === true) {
      console.log('[RoleMigration] Migration already completed previously according to lock.');
      // We can run a quick check to see if any users are still active and unmigrated just in case, but let's avoid redundant writes.
      return null;
    }

    console.log('[RoleMigration] Starting production-safe role standardization migration...');
    const now = new Date().toISOString();

    // 1. SCAN AND MIGRATE USERS
    const usersSnap = await getDocs(collection(db, 'users'));
    const oldTLRolesSet = new Set<string>();
    let usersMigratedCount = 0;

    let userBatch = writeBatch(db);
    let userOps = 0;

    const isOldTLRole = (role: string | undefined | null): boolean => {
      if (!role) return false;
      const r = role.toString().trim();
      const upper = r.toUpperCase();
      if (['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TEAM LEAD', 'TRAINER TL', 'OPS TL', 'OPS_TEAM_LEAD', 'TEAM_LEADER', 'TEAM LEADER'].includes(upper)) {
        return true;
      }
      if (upper.endsWith('_TL') || upper.endsWith(' TL')) {
        return true;
      }
      return false;
    };

    usersSnap.docs.forEach(userDoc => {
      const u = userDoc.data();
      const currentRole = u.role;
      const statusActive = !u.status || u.status.toLowerCase().trim() === 'active' || u.isActive === true;

      if (isOldTLRole(currentRole) && statusActive) {
        const originalRoleStr = String(currentRole);
        oldTLRolesSet.add(originalRoleStr);

        let dept = u.department || '';
        if (!dept || dept.trim().length === 0) {
          const upperRole = originalRoleStr.toUpperCase();
          if (upperRole.includes('QTL')) {
            dept = 'QA';
          } else if (upperRole.includes('TRAINER')) {
            dept = 'Training';
          } else if (upperRole.includes('OPS')) {
            dept = 'Operations';
          } else if (upperRole.includes('STL')) {
            dept = 'Operations';
          } else {
            dept = 'Operations';
          }
        }

        userBatch.set(doc(db, 'users', userDoc.id), {
          role: 'Team Lead',
          department: dept,
          lastUpdated: now
        }, { merge: true });

        usersMigratedCount++;
        userOps++;

        if (userOps >= 400) {
          userBatch.commit();
          userBatch = writeBatch(db);
          userOps = 0;
        }
      }
    });

    if (userOps > 0) {
      await userBatch.commit();
    }

    report.usersMigrated = usersMigratedCount;
    report.oldRolesFound = Array.from(oldTLRolesSet);

    // 2. MIGRATE FIRESTORE ROLE DOCUMENTS
    const rolesBatch = writeBatch(db);
    
    // Create new standardized "Team Lead" active role document
    rolesBatch.set(doc(db, 'roles', 'Team Lead'), {
      id: 'Team Lead',
      name: 'Team Lead',
      description: 'Standardized Team Lead Role (Merged STL, QTL, Ops_TL, Trainer_TL)',
      status: 'Active',
      createdAt: now
    }, { merge: true });

    // Archive / deactivate older TL roles without deleting historical records
    const oldTLRoleKeys = ['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TEAM LEAD'];
    oldTLRoleKeys.forEach(roleKey => {
      rolesBatch.set(doc(db, 'roles', roleKey), {
        status: 'Inactive',
        archived: true,
        lastUpdated: now
      }, { merge: true });
    });

    await rolesBatch.commit();

    // 3. UPDATE PERMISSION MAPPINGS
    // Fetch all existing permissions to copy/merge
    const permsSnap = await getDocs(collection(db, 'role_permissions'));
    const permsByModule: Record<string, any> = {};

    permsSnap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const roleName = (data.role_name || '').toString().toUpperCase().trim();
      const moduleName = data.module_name;

      if (!moduleName) return;

      const isTL = ['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TEAM LEAD', 'TEAM_LEADER', 'TEAM LEADER'].includes(roleName) || roleName.endsWith('_TL');
      
      if (isTL) {
        if (!permsByModule[moduleName]) {
          permsByModule[moduleName] = {
            can_view: false,
            can_create: false,
            can_edit: false,
            can_delete: false,
            can_export: false,
            can_approve: false
          };
        }

        // Merge permissions using OR operation (identical access retention)
        permsByModule[moduleName].can_view = permsByModule[moduleName].can_view || !!data.can_view;
        permsByModule[moduleName].can_create = permsByModule[moduleName].can_create || !!data.can_create;
        permsByModule[moduleName].can_edit = permsByModule[moduleName].can_edit || !!data.can_edit;
        permsByModule[moduleName].can_delete = permsByModule[moduleName].can_delete || !!data.can_delete;
        permsByModule[moduleName].can_export = permsByModule[moduleName].can_export || !!data.can_export;
        permsByModule[moduleName].can_approve = permsByModule[moduleName].can_approve || !!data.can_approve;
      }
    });

    // Write merged permissions for "Team Lead"
    const permsBatch = writeBatch(db);
    let permsOps = 0;

    Object.entries(permsByModule).forEach(([moduleName, perms]) => {
      const permId = `Team Lead_${moduleName}`;
      permsBatch.set(doc(db, 'role_permissions', permId), {
        role_name: 'Team Lead',
        module_name: moduleName,
        ...perms,
        lastUpdated: now
      }, { merge: true });

      report.permissionsUpdated.push(moduleName);
      permsOps++;
    });

    if (permsOps > 0) {
      await permsBatch.commit();
    }

    // Set lock so it doesn't run again on subsequent sessions
    await setDoc(lockRef, {
      completed: true,
      migratedAt: now,
      report: report
    });

    console.log('[RoleMigration] Migration completed successfully!', report);
    return report;

  } catch (error) {
    console.error('[RoleMigration] Critical error during migration:', error);
    return report;
  }
}
