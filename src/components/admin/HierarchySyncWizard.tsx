import React, { useState, useMemo, useEffect } from 'react';
import { 
  Shield, RefreshCw, AlertTriangle, CheckCircle2, Users, Search, 
  ChevronRight, ChevronDown, Check, AlertCircle, Info, ArrowRight, PlayCircle, Eye, CornerDownRight, X, UserMinus, Plus, UserCheck, Zap, ShieldAlert,
  FileSpreadsheet, FileDown, Upload
} from 'lucide-react';
import { db, auth } from '../../lib/firebase';
import { collection, doc, getDocs, writeBatch, setDoc, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { useRoster } from '../../contexts/RosterContext';
import { OrgTree, normalizeHierarchyUser, validateHierarchy, NodeValidationResult, HierarchyHealthSummary, buildAuthoritativeLookupMaps, normalizeHierarchyReference, getHierarchyPersistencePayload } from '../../lib/hierarchy';
import { safeStorage } from '../../lib/safeStorage';
import { BulkHierarchyRepairModal } from './BulkHierarchyRepairModal';
import { IdentityNormalizationModal } from './IdentityNormalizationModal';

interface HierarchySyncWizardProps {
  allUsers: any[];
  adminTheme: 'light' | 'dark';
  onRefresh: () => void;
  logAdminEvent: (action: string, affectedUser: string, prevValue: string, newValue: string) => Promise<void>;
}

export const HierarchySyncWizard: React.FC<HierarchySyncWizardProps> = ({
  allUsers,
  adminTheme,
  onRefresh,
  logAdminEvent
}) => {
  const { updateMultipleUsersInRoster, updateUserInRoster, refreshRoster } = useRoster();
  const [activeTab, setActiveTab] = useState<'inspector' | 'diagnostics'>('inspector');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [processFilter, setProcessFilter] = useState<string>('ALL');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  
  // Inspector Selection State
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

  const toggleExpand = (uid: string) => {
    setExpandedNodes(prev => ({
      ...prev,
      [uid]: !prev[uid]
    }));
  };
  
  // Repair Proposal State
  const [proposedTLUid, setProposedTLUid] = useState<string | null>(null);
  const [proposedMgrUid, setProposedMgrUid] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [tlSearchQuery, setTlSearchQuery] = useState('');
  const [mgrSearchQuery, setMgrSearchQuery] = useState('');

  // Diagnostics Tab State
  const [diagActorUid, setDiagActorUid] = useState('');
  const [diagTargetUid, setDiagTargetUid] = useState('');
  const [diagActorSearch, setDiagActorSearch] = useState('');
  const [diagTargetSearch, setDiagTargetSearch] = useState('');
  const [diagnosticResult, setDiagnosticResult] = useState<any | null>(null);

  const [diagnosticsStarted, setDiagnosticsStarted] = useState(false);
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [isIdentityModalOpen, setIsIdentityModalOpen] = useState(false);

  // 1. Build canonical tree and run health validator
  const tree = useMemo(() => {
    if (!diagnosticsStarted) return new OrgTree([]);
    return new OrgTree(allUsers);
  }, [allUsers, diagnosticsStarted]);
  
  const validation = useMemo(() => {
    if (!diagnosticsStarted) {
      return { 
        results: new Map<string, NodeValidationResult>(), 
        summary: { total: 0, healthy: 0, orphans: 0, cycles: 0, invalidParents: 0, unmapped: 0, conflicts: 0, rawRefs: 0 } 
      };
    }
    return validateHierarchy(allUsers);
  }, [allUsers, diagnosticsStarted]);

  const { results: validationResults, summary: healthSummary } = validation;

  // 2. Identify root-level nodes (nodes with no parent)
  const roots = useMemo(() => {
    if (!diagnosticsStarted) return [];
    const rootIds: string[] = [];
    allUsers.forEach(u => {
      const node = tree.getNode(u.uid);
      if (node && !node.parentUid) {
        rootIds.push(u.uid);
      }
    });
    // Sort alphabetically by name
    return rootIds.sort((a, b) => {
      const uA = allUsers.find(u => u.uid === a);
      const uB = allUsers.find(u => u.uid === b);
      return (uA?.name || '').localeCompare(uB?.name || '');
    });
  }, [allUsers, tree, diagnosticsStarted]);

  // Unique lists for filters
  const processes = useMemo(() => {
    if (!diagnosticsStarted) return [];
    const set = new Set<string>();
    allUsers.forEach(u => { if (u.process) set.add(u.process); });
    return Array.from(set).sort();
  }, [allUsers, diagnosticsStarted]);

  const roles = useMemo(() => {
    if (!diagnosticsStarted) return [];
    const set = new Set<string>();
    allUsers.forEach(u => { if (u.role) set.add(u.role.toString().toUpperCase().trim()); });
    return Array.from(set).sort();
  }, [allUsers, diagnosticsStarted]);

  // 3. Match search query & filters to expand matches
  useEffect(() => {
    if (searchQuery || statusFilter !== 'ALL' || processFilter !== 'ALL' || roleFilter !== 'ALL') {
      const matchingUids = allUsers.filter(u => {
        const matchesSearch = !searchQuery || 
          (u.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (u.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (u.uid || '').toLowerCase().includes(searchQuery.toLowerCase());
        
        const val = validationResults.get(u.uid);
        const matchesStatus = statusFilter === 'ALL' || (val && val.status === statusFilter);
        const matchesProcess = processFilter === 'ALL' || u.process === processFilter;
        const matchesRole = roleFilter === 'ALL' || (u.role && u.role.toString().toUpperCase().trim() === roleFilter);

        return matchesSearch && matchesStatus && matchesProcess && matchesRole;
      }).map(u => u.uid);

      // Auto-expand ancestors so search results are visible in tree
      const newExpanded = { ...expandedNodes };
      matchingUids.forEach(uid => {
        const ancestors = tree.getAncestors(uid);
        ancestors.forEach(a => {
          newExpanded[a] = true;
        });
      });
      setExpandedNodes(newExpanded);
    }
  }, [searchQuery, statusFilter, processFilter, roleFilter, allUsers, tree]);

  // Get visible list of nodes under the tree structure
  const visibleNodes = useMemo(() => {
    const list: { uid: string; depth: number }[] = [];
    const visited = new Set<string>();

    const visit = (uid: string, depth: number) => {
      if (visited.has(uid)) return; // Prevents crashing on cycles
      visited.add(uid);
      
      const user = allUsers.find(u => u.uid === uid);
      if (!user) return;

      // Apply filtering if NOT matching search/filter but having matching children
      const val = validationResults.get(uid);
      
      const matchesSearch = !searchQuery || 
        (user.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (user.email || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (user.uid || '').toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesStatus = statusFilter === 'ALL' || (val && val.status === statusFilter);
      const matchesProcess = processFilter === 'ALL' || user.process === processFilter;
      const matchesRole = roleFilter === 'ALL' || (user.role && user.role.toString().toUpperCase().trim() === roleFilter);

      const isMatch = matchesSearch && matchesStatus && matchesProcess && matchesRole;

      if (isMatch) {
        list.push({ uid, depth });
      }

      // If expanded or if we are actively searching (so descendants of matches can be inspected), visit children
      if (expandedNodes[uid] || searchQuery || statusFilter !== 'ALL' || processFilter !== 'ALL' || roleFilter !== 'ALL') {
        const children = tree.getNode(uid)?.children || [];
        children.sort((a, b) => {
          const uA = allUsers.find(u => u.uid === a);
          const uB = allUsers.find(u => u.uid === b);
          return (uA?.name || '').localeCompare(uB?.name || '');
        }).forEach(childUid => visit(childUid, depth + 1));
      }
    };

    roots.forEach(r => visit(r, 0));
    return list;
  }, [roots, expandedNodes, tree, allUsers, searchQuery, statusFilter, processFilter, roleFilter, validationResults]);

  // Selected User Object
  const selectedUser = useMemo(() => {
    if (!selectedUid) return null;
    return allUsers.find(u => u.uid === selectedUid) || null;
  }, [selectedUid, allUsers]);

  // Initialize Repair Form when user selection changes
  useEffect(() => {
    if (selectedUser) {
      const norm = normalizeHierarchyUser(selectedUser);
      setProposedTLUid(norm.teamLeadUid);
      setProposedMgrUid(norm.managerUid);
      setTlSearchQuery('');
      setMgrSearchQuery('');
    }
  }, [selectedUser]);

  // List of possible supervisors for dropdown
  const eligibleSupervisors = useMemo(() => {
    return allUsers.filter(u => {
      // Exclude self, and exclude any direct/indirect reports to prevent loops
      if (u.uid === selectedUid) return false;
      if (selectedUid) {
        const descendants = tree.getDescendants(selectedUid);
        if (descendants.has(u.uid)) return false;
      }
      return true;
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [allUsers, selectedUid, tree]);

  const filteredTLs = useMemo(() => {
    if (!tlSearchQuery) return eligibleSupervisors.slice(0, 50);
    return eligibleSupervisors.filter(u => 
      (u.name || '').toLowerCase().includes(tlSearchQuery.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(tlSearchQuery.toLowerCase())
    ).slice(0, 50);
  }, [eligibleSupervisors, tlSearchQuery]);

  const filteredMgrs = useMemo(() => {
    if (!mgrSearchQuery) return eligibleSupervisors.slice(0, 50);
    return eligibleSupervisors.filter(u => 
      (u.name || '').toLowerCase().includes(mgrSearchQuery.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(mgrSearchQuery.toLowerCase())
    ).slice(0, 50);
  }, [eligibleSupervisors, mgrSearchQuery]);

  // Real-time repair impact simulation (Before/After Preview)
  const repairImpact = useMemo(() => {
    if (!selectedUid) return null;

    // 1. Current state downline & descendants
    const currentDescendants = Array.from(tree.getDescendants(selectedUid)) as string[];
    const currentDownlineNames = currentDescendants.map(id => allUsers.find(u => u.uid === id)?.name || id);

    // 2. Build mock users with proposed relationships
    const simulatedUsers = allUsers.map(u => {
      if (u.uid === selectedUid) {
        return {
          ...u,
          teamLeadUid: proposedTLUid,
          teamLeadId: proposedTLUid || '',
          managerUid: proposedMgrUid,
          managerId: proposedMgrUid || '',
          mappedManagerUid: proposedMgrUid,
          mappedManagerId: proposedMgrUid || ''
        };
      }
      return u;
    });

    const simulatedTree = new OrgTree(simulatedUsers);

    // 3. Detect circular reporting in mock tree
    let introducesCycle = false;
    const visited = new Set<string>();
    let curr: string | null = selectedUid;
    while (curr) {
      if (visited.has(curr)) {
        introducesCycle = true;
        break;
      }
      visited.add(curr);
      const user = simulatedUsers.find(u => u.uid === curr);
      if (!user) break;
      const norm = normalizeHierarchyUser(user);
      curr = norm.teamLeadUid || norm.managerUid || null;
    }

    // 4. TMS scoping impact
    // Current visibility set for the selected user
    const currentTmsSet = new Set<string>(currentDescendants);
    if (selectedUid) currentTmsSet.add(selectedUid);

    // Proposed visibility set
    const proposedDescendants = Array.from(simulatedTree.getDescendants(selectedUid)) as string[];
    const proposedTmsSet = new Set<string>(proposedDescendants);
    if (selectedUid) proposedTmsSet.add(selectedUid);

    const addedToTms = Array.from(proposedTmsSet).filter((id): id is string => !!id && !currentTmsSet.has(id)).map(id => allUsers.find(u => u.uid === id)?.name || id);
    const removedFromTms = Array.from(currentTmsSet).filter((id): id is string => !!id && !proposedTmsSet.has(id)).map(id => allUsers.find(u => u.uid === id)?.name || id);

    return {
      introducesCycle,
      downlineCount: proposedDescendants.length,
      downlineNames: proposedDescendants.map(id => allUsers.find(u => u.uid === id)?.name || id),
      addedToTms,
      removedFromTms
    };
  }, [selectedUid, proposedTLUid, proposedMgrUid, allUsers, tree]);

  // Repair execution & verification write
  const handleExecuteRepair = async () => {
    if (!selectedUid || !selectedUser) return;
    if (repairImpact?.introducesCycle) {
      toast.error('Cannot save: This assignment would introduce a circular reporting cycle!');
      return;
    }

    setIsSaving(true);
    const toastId = toast.loading('Executing authoritative hierarchy repair...');

    try {
      const batch = writeBatch(db);

      const targetRef = doc(db, 'employee_master', selectedUid);
      const mappingRef = doc(db, 'teamMappings', selectedUid);

      const tlUser = proposedTLUid ? allUsers.find(u => u.uid === proposedTLUid) : null;
      const mgrUser = proposedMgrUid ? allUsers.find(u => u.uid === proposedMgrUid) : null;

      const normTarget = normalizeHierarchyUser(selectedUser);

      const oldTLUid = normTarget.teamLeadUid;
      const oldMgrUid = normTarget.managerUid;

      const updatePayload = {
        teamLeadId: proposedTLUid || '',
        teamLeadUid: proposedTLUid || '',
        teamLeadName: tlUser ? (tlUser.fullName || tlUser.name || '') : '',
        teamLeadEmail: tlUser ? (tlUser.email || '').toLowerCase() : '',
        managerId: proposedMgrUid || '',
        managerUid: proposedMgrUid || '',
        mappedManagerId: proposedMgrUid || '',
        mappedManagerUid: proposedMgrUid || '',
        managerName: mgrUser ? (mgrUser.fullName || mgrUser.name || '') : '',
        managerEmail: mgrUser ? (mgrUser.email || '').toLowerCase() : '',
        mappedManagerName: mgrUser ? (mgrUser.fullName || mgrUser.name || '') : '',
        mappedManagerEmail: mgrUser ? (mgrUser.email || '').toLowerCase() : '',
        lastUpdated: new Date().toISOString()
      };

      batch.set(targetRef, updatePayload, { merge: true });

      // Mirrored entry in teamMappings
      const mappingPayload = {
        userId: selectedUid,
        userName: selectedUser.fullName || selectedUser.name || '',
        teamLeadId: proposedTLUid || '',
        teamLeadName: tlUser ? (tlUser.fullName || tlUser.name || '') : '',
        managerId: proposedMgrUid || '',
        managerName: mgrUser ? (mgrUser.fullName || mgrUser.name || '') : '',
        process: selectedUser.process || '',
        lastUpdated: new Date().toISOString()
      };
      batch.set(mappingRef, mappingPayload);

      await batch.commit();

      // Read-after-write verification
      const verifySnap = await getDoc(targetRef);
      const verifyData = verifySnap.data();
      if (!verifySnap.exists() || verifyData?.teamLeadUid !== (proposedTLUid || '')) {
        throw new Error('Read-after-write integrity verification failed. Document discrepancy detected.');
      }

      // Write authoritative hierarchy audit log
      const logRef = doc(collection(db, 'hierarchyAuditLogs'));
      await setDoc(logRef, {
        timestamp: new Date().toISOString(),
        actor: auth.currentUser?.email || 'admin@precision360.co.in',
        target: selectedUser.email || selectedUser.uid,
        operation: 'REPAIR',
        before: {
          teamLeadUid: oldTLUid || null,
          managerUid: oldMgrUid || null
        },
        after: {
          teamLeadUid: proposedTLUid || null,
          managerUid: proposedMgrUid || null
        },
        verification: 'PASSED'
      });

      // Clear local IndexedDB hierarchy, roster, and downline caches
      await safeStorage.deleteIndexedDB(`precision360_hierarchy_nodes_${selectedUid}`);
      await safeStorage.deleteIndexedDB(`precision360_roster_cache_${selectedUid}`);
      if (oldTLUid) {
        await safeStorage.deleteIndexedDB(`precision360_roster_cache_${oldTLUid}`);
      }
      if (proposedTLUid) {
        await safeStorage.deleteIndexedDB(`precision360_roster_cache_${proposedTLUid}`);
      }

      // Invalidate subordinates caches
      await safeStorage.clearAllIndexedDBByPrefix('subordinates_v5_');

      const tlName = tlUser ? (tlUser.fullName || tlUser.name || '') : undefined;
      const mgrName = mgrUser ? (mgrUser.fullName || mgrUser.name || '') : undefined;

      await updateUserInRoster({
        uid: selectedUid,
        teamLeadUid: proposedTLUid || undefined,
        teamLeadId: proposedTLUid || undefined,
        teamLeadName: tlName,
        mappedTL: tlName,
        managerUid: proposedMgrUid || undefined,
        managerId: proposedMgrUid || undefined,
        managerName: mgrName,
        mappedManagerId: proposedMgrUid || undefined,
        mappedManagerName: mgrName
      });

      toast.success('Authoritative repair completed & verified successfully!', { id: toastId });
      
      // Log admin audit
      await logAdminEvent(
        'Authoritative Hierarchy Repair',
        `${selectedUser.name || selectedUser.fullName} (${selectedUid})`,
        `TL: ${oldTLUid || 'None'}, Mgr: ${oldMgrUid || 'None'}`,
        `TL: ${proposedTLUid || 'None'}, Mgr: ${proposedMgrUid || 'None'}`
      );

      // Trigger full parents refresh
      onRefresh();
      await refreshRoster(false, false);
    } catch (err: any) {
      console.error('[HIERARCHY_REPAIR] Save failed:', err);
      toast.error(`Repair Failed: ${err.message || 'Firestore transaction error'}`, { id: toastId });
    } finally {
      setIsSaving(false);
    }
  };

  const bulkRepairableCount = useMemo(() => {
    let count = 0;
    validationResults.forEach((val) => {
      if (val.status === 'LEGACY_RAW_REFERENCE' || val.status === 'MISSING_CANONICAL_UID') {
        count++;
      }
    });
    return count;
  }, [validationResults]);

  const handleBulkRepair = async () => {
    const repairableUids: string[] = [];
    validationResults.forEach((val, uid) => {
      if (val.status === 'LEGACY_RAW_REFERENCE' || val.status === 'MISSING_CANONICAL_UID') {
        repairableUids.push(uid);
      }
    });

    if (repairableUids.length === 0) {
      toast.info('No un-canonicalized or legacy mappings require automated repair.');
      return;
    }

    setIsSaving(true);
    const toastId = toast.loading(`Bulk repairing ${repairableUids.length} hierarchy mappings...`);

    try {
      const lookupMaps = buildAuthoritativeLookupMaps(allUsers);
      const batch = writeBatch(db);

      repairableUids.forEach((uid) => {
        const u = allUsers.find(x => x.uid === uid);
        if (!u) return;

        const rawTl = u.teamLeadUid || u.teamLeadId || u.tlId;
        const rawMgr = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId;

        const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
        const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

        const hierarchyPayload = getHierarchyPersistencePayload({
          userUid: uid,
          teamLeadUid: resolvedTLUid,
          managerUid: resolvedManagerUid,
          allUsers
        });

        const userRef = doc(db, 'users', uid);
        const masterRef = doc(db, 'employee_master', uid);
        const mappingRef = doc(db, 'teamMappings', uid);

        batch.set(userRef, hierarchyPayload, { merge: true });
        batch.set(masterRef, hierarchyPayload, { merge: true });
        batch.set(mappingRef, hierarchyPayload, { merge: true });
      });

      await batch.commit();

      // Read-after-write verification
      let verifiedMismatches = 0;
      for (const uid of repairableUids) {
        const u = allUsers.find(x => x.uid === uid);
        if (!u) continue;
        const rawTl = u.teamLeadUid || u.teamLeadId || u.tlId;
        const rawMgr = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId;
        const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps) || '';
        const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps) || '';

        const snap = await getDoc(doc(db, 'employee_master', uid));
        if (snap.exists()) {
          const d = snap.data();
          if ((d.teamLeadUid || '') !== resolvedTLUid || (d.managerUid || '') !== resolvedManagerUid) {
            verifiedMismatches++;
          }
        }
      }

      if (verifiedMismatches > 0) {
        throw new Error(`Bulk repair verification failed with ${verifiedMismatches} mismatches.`);
      }

      const updates = repairableUids.map(uid => {
        const u = allUsers.find(x => x.uid === uid);
        if (!u) return { uid };
        const rawTl = u.teamLeadUid || u.teamLeadId || u.tlId;
        const rawMgr = u.mappedManagerUid || u.mappedManagerId || u.managerUid || u.managerId;
        const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps) || '';
        const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps) || '';
        const tlObj = allUsers.find(x => x.uid === resolvedTLUid);
        const mgrObj = allUsers.find(x => x.uid === resolvedManagerUid);
        const resolvedTLName = tlObj ? (tlObj.fullName || tlObj.name || '') : undefined;
        const resolvedManagerName = mgrObj ? (mgrObj.fullName || mgrObj.name || '') : undefined;
        return {
          uid,
          teamLeadUid: resolvedTLUid || undefined,
          teamLeadId: resolvedTLUid || undefined,
          teamLeadName: resolvedTLName,
          mappedTL: resolvedTLName,
          managerUid: resolvedManagerUid || undefined,
          managerId: resolvedManagerUid || undefined,
          managerName: resolvedManagerName,
          mappedManagerId: resolvedManagerUid || undefined,
          mappedManagerName: resolvedManagerName
        };
      });

      await updateMultipleUsersInRoster(updates);

      toast.success(`Successfully repaired & verified ${repairableUids.length} hierarchy mappings!`, { id: toastId });
      onRefresh();
      await refreshRoster(false, false);
    } catch (err: any) {
      console.error(err);
      toast.error(`Bulk repair failed: ${err.message}`, { id: toastId });
    } finally {
      setIsSaving(false);
    }
  };

  // Diagnostics Actor Search
  const diagActors = useMemo(() => {
    return allUsers.filter(u => ['ADMIN', 'MANAGER', 'OPS_HEAD', 'TEAM_LEAD', 'STL', 'OPS_TL', 'VP', 'DIRECTOR'].includes(u.role?.toString().toUpperCase().trim()));
  }, [allUsers]);

  const filteredDiagActors = useMemo(() => {
    if (!diagActorSearch) return diagActors.slice(0, 10);
    return diagActors.filter(u => 
      (u.name || '').toLowerCase().includes(diagActorSearch.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(diagActorSearch.toLowerCase())
    ).slice(0, 10);
  }, [diagActors, diagActorSearch]);

  const filteredDiagTargets = useMemo(() => {
    if (!diagTargetSearch) return allUsers.slice(0, 10);
    return allUsers.filter(u => 
      (u.name || '').toLowerCase().includes(diagTargetSearch.toLowerCase()) ||
      (u.email || '').toLowerCase().includes(diagTargetSearch.toLowerCase())
    ).slice(0, 10);
  }, [allUsers, diagTargetSearch]);

  // Trace TMS Visibility & Diagnostics
  const handleRunDiagnosis = () => {
    if (!diagActorUid || !diagTargetUid) {
      toast.error('Please select both a Supervisor (Actor) and an Employee (Target).');
      return;
    }

    const actor = allUsers.find(u => u.uid === diagActorUid);
    const target = allUsers.find(u => u.uid === diagTargetUid);

    if (!actor || !target) {
      toast.error('Selected users not found in dataset.');
      return;
    }

    const actorTree = new OrgTree(allUsers);
    const descendants = actorTree.getDescendants(diagActorUid);
    const isAccessible = descendants.has(diagTargetUid) || diagActorUid === diagTargetUid;

    // Trace path
    const path: string[] = [];
    let curr: string | null = diagTargetUid;
    const visited = new Set<string>();
    let cycleDetected = false;

    while (curr) {
      if (visited.has(curr)) {
        cycleDetected = true;
        break;
      }
      visited.add(curr);
      const user = allUsers.find(u => u.uid === curr);
      if (user) {
        path.unshift(user.name || user.fullName || curr);
      } else {
        path.unshift(`[Missing UID: ${curr}]`);
      }
      
      const node = actorTree.getNode(curr);
      curr = node?.parentUid || null;
    }

    // Diagnostics Analysis
    const findings: string[] = [];
    if (target.status === 'Inactive' || target.status === 'Suspended') {
      findings.push('Target employee is marked as INACTIVE or SUSPENDED.');
    }

    const targetVal = validationResults.get(diagTargetUid);
    if (targetVal && targetVal.status !== 'HEALTHY') {
      findings.push(`Target employee has hierarchy health issues: ${targetVal.message} (${targetVal.details || ''})`);
    }

    if (!isAccessible) {
      findings.push('There is no reporting link connecting the Actor (Supervisor) to the Target (Employee) in the hierarchy tree.');
      findings.push('The employee reports to a separate distinct subtree or is completely unmapped.');
    }

    setDiagnosticResult({
      actor: actor.name || actor.fullName,
      target: target.name || target.fullName,
      isAccessible,
      path,
      cycleDetected,
      findings
    });
  };

  const cardClass = adminTheme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const bgBadge = (status: NodeValidationResult['status']) => {
    switch (status) {
      case 'HEALTHY': return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-400 border-emerald-100 dark:border-emerald-900';
      case 'ORPHAN': return 'bg-rose-50 text-rose-700 dark:bg-rose-950/20 dark:text-rose-400 border-rose-100 dark:border-rose-900';
      case 'UNMAPPED': return 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400 border-amber-100 dark:border-amber-900';
      case 'CONFLICT': return 'bg-orange-50 text-orange-700 dark:bg-orange-950/20 dark:text-orange-400 border-orange-100 dark:border-orange-900';
      case 'CYCLE': return 'bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-400 border-red-100 dark:border-red-900';
      case 'INVALID PARENT': return 'bg-purple-50 text-purple-700 dark:bg-purple-950/20 dark:text-purple-400 border-purple-100 dark:border-purple-900';
      case 'LEGACY_RAW_REFERENCE': return 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400 border-amber-100 dark:border-amber-900';
      case 'MISSING_CANONICAL_UID': return 'bg-orange-50 text-orange-700 dark:bg-orange-950/20 dark:text-orange-400 border-orange-100 dark:border-orange-900';
      default: return 'bg-slate-50 text-slate-700 dark:bg-slate-950/20 dark:text-slate-400 border-slate-100 dark:border-slate-900';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      
      {/* 1. Header & Navigation Tab Bar */}
      <div className={`${cardClass} border rounded-2xl p-6 shadow-sm`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-black text-slate-800 dark:text-white uppercase tracking-tight flex items-center gap-2">
              <Shield size={20} className="text-indigo-500" /> Precision360 Org Tree & Repair
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Interactive structural validation center. Audit integrity, repair reporting lines, and simulate TMS dashboard visibility changes instantly.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setIsIdentityModalOpen(true)}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition shadow-sm active:scale-95 cursor-pointer"
            >
              <ShieldAlert size={15} /> Identity Normalizer
            </button>
            <button
              onClick={() => setIsBulkModalOpen(true)}
              className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition shadow-sm active:scale-95 cursor-pointer"
            >
              <FileSpreadsheet size={15} /> Bulk Export & Repair
            </button>

            <div className="flex border-b border-slate-100 dark:border-slate-800 pb-1 gap-2">
              <button 
                onClick={() => setActiveTab('inspector')}
                className={`px-4 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer ${activeTab === 'inspector' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
              >
                Org Tree Inspector
              </button>
              <button 
                onClick={() => setActiveTab('diagnostics')}
                className={`px-4 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer ${activeTab === 'diagnostics' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
              >
                TMS Access Diagnostics
              </button>
            </div>
          </div>
        </div>
      </div>

      {!diagnosticsStarted ? (
        <div className={`${cardClass} border rounded-2xl p-8 shadow-sm text-center max-w-2xl mx-auto space-y-6 mt-6`}>
          <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-950/40 rounded-full flex items-center justify-center mx-auto text-indigo-500">
            <Shield size={32} />
          </div>
          <div className="space-y-2">
            <h4 className="text-lg font-black text-slate-800 dark:text-white uppercase tracking-tight">
              Load Organization Tree & Repair Center
            </h4>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Build, parse, and validate the complete organizational tree hierarchy ({allUsers.length} total users) in memory. This tool executes entirely client-side using locally cached datasets.
            </p>
          </div>
          <button
            onClick={() => setDiagnosticsStarted(true)}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs uppercase tracking-wider px-6 py-3 rounded-xl transition shadow-sm animate-bounce"
          >
            <PlayCircle size={16} /> Run Integrity Diagnostics
          </button>
        </div>
      ) : (
        <>
          {/* 2. Health Metrics Summary Cards */}
          {activeTab === 'inspector' && (
            <div className={`${cardClass} border rounded-2xl p-6 shadow-sm mt-6`}>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                <div className="bg-slate-50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800/40 text-center">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Users</div>
                  <div className="text-lg font-black text-slate-800 dark:text-slate-200 mt-1">{healthSummary.total}</div>
                </div>
                <div className="bg-emerald-50/50 dark:bg-emerald-950/10 p-3 rounded-xl border border-emerald-100/40 dark:border-emerald-900/10 text-center">
                  <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Healthy</div>
                  <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 mt-1">{healthSummary.healthy}</div>
                </div>
                <div className="bg-rose-50/50 dark:bg-rose-950/10 p-3 rounded-xl border border-rose-100/40 dark:border-rose-900/10 text-center">
                  <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider">Orphans</div>
                  <div className="text-lg font-black text-rose-600 dark:text-rose-400 mt-1">{healthSummary.orphans}</div>
                </div>
                <div className="bg-amber-50/50 dark:bg-amber-950/10 p-3 rounded-xl border border-amber-100/40 dark:border-amber-900/10 text-center">
                  <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Unmapped</div>
                  <div className="text-lg font-black text-amber-600 dark:text-amber-400 mt-1">{healthSummary.unmapped}</div>
                </div>
                <div className="bg-orange-50/50 dark:bg-orange-950/10 p-3 rounded-xl border border-orange-100/40 dark:border-orange-900/10 text-center">
                  <div className="text-[10px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wider">Conflicts</div>
                  <div className="text-lg font-black text-orange-600 dark:text-orange-400 mt-1">{healthSummary.conflicts}</div>
                </div>
                <div className="bg-red-50/50 dark:bg-red-950/10 p-3 rounded-xl border border-red-100/40 dark:border-red-900/10 text-center">
                  <div className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">Cycles</div>
                  <div className="text-lg font-black text-red-600 dark:text-red-400 mt-1">{healthSummary.cycles}</div>
                </div>
                <div className="bg-purple-50/50 dark:bg-purple-950/10 p-3 rounded-xl border border-purple-100/40 dark:border-purple-900/10 text-center">
                  <div className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Inv Parents</div>
                  <div className="text-lg font-black text-purple-600 dark:text-purple-400 mt-1">{healthSummary.invalidParents}</div>
                </div>
              </div>
            </div>
          )}

      {/* 3. Main Workspace Tab Contents */}
      {activeTab === 'inspector' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* Left Panel: Org Tree Navigation & Filters */}
          <div className="lg:col-span-7 space-y-4">
            <div className={`${cardClass} border rounded-2xl p-4 shadow-sm space-y-4`}>
              
              {/* Search & Advanced Filters Bar */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="md:col-span-2 relative">
                  <Search size={14} className="absolute left-3 top-3 text-slate-400" />
                  <input 
                    type="text" 
                    placeholder="Search by Name, Email, or UID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-3 text-slate-400 hover:text-slate-600">
                      <X size={12} />
                    </button>
                  )}
                </div>
                
                {/* Health Filter */}
                <div>
                  <select 
                    value={statusFilter} 
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full px-2 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-[11px] font-bold bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300"
                  >
                    <option value="ALL">Health: All</option>
                    <option value="HEALTHY">🟢 Healthy</option>
                    <option value="ORPHAN">🔴 Orphans</option>
                    <option value="UNMAPPED">🔴 Unmapped</option>
                    <option value="CONFLICT">🟠 Conflicts</option>
                    <option value="CYCLE">🔴 Cycles</option>
                    <option value="INVALID PARENT">🔴 Invalid Parent</option>
                    <option value="LEGACY_RAW_REFERENCE">⚠️ Legacy Raw Reference</option>
                    <option value="MISSING_CANONICAL_UID">⚠️ Missing Canonical UID</option>
                  </select>
                </div>

                {/* Role Filter */}
                <div>
                  <select 
                    value={roleFilter} 
                    onChange={(e) => setRoleFilter(e.target.value)}
                    className="w-full px-2 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-[11px] font-bold bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300"
                  >
                    <option value="ALL">Role: All</option>
                    {roles.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Bulk Repair Alert Banner */}
              {bulkRepairableCount > 0 && (
                <div className="flex items-center justify-between p-3.5 bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-900/30 rounded-xl">
                  <div className="flex items-center gap-2">
                    <Zap size={14} className="text-amber-500 animate-pulse" />
                    <span className="text-[11px] font-extrabold text-amber-800 dark:text-amber-400">
                      {bulkRepairableCount} users have legacy raw text references or missing canonical indexing fields.
                    </span>
                  </div>
                  <button 
                    onClick={handleBulkRepair}
                    disabled={isSaving}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-all disabled:opacity-50 flex-shrink-0"
                  >
                    {isSaving ? 'Repairing...' : 'Repair All'}
                  </button>
                </div>
              )}

              {/* Collapsible Tree Container */}
              <div className="border border-slate-100 dark:border-slate-800/60 rounded-xl max-h-[600px] overflow-y-auto divide-y divide-slate-50 dark:divide-slate-850 bg-slate-50/50 dark:bg-slate-950/20">
                {visibleNodes.length === 0 ? (
                  <div className="p-8 text-center text-slate-400 italic text-xs">
                    No nodes match the active filters or search query.
                  </div>
                ) : (
                  visibleNodes.map(({ uid, depth }) => {
                    const node = tree.getNode(uid);
                    const user = allUsers.find(u => u.uid === uid);
                    const isExpanded = expandedNodes[uid] || false;
                    const val = validationResults.get(uid);
                    const hasChildren = node && node.children.length > 0;
                    const isSelected = selectedUid === uid;

                    if (!user) return null;

                    return (
                      <div 
                        key={uid}
                        style={{ paddingLeft: `${Math.max(12, depth * 16)}px` }}
                        className={`flex items-center justify-between py-2.5 pr-3 cursor-pointer transition-all ${isSelected ? 'bg-indigo-50/60 dark:bg-indigo-950/30 border-l-2 border-indigo-600' : 'hover:bg-slate-50 dark:hover:bg-slate-850/40'}`}
                        onClick={() => setSelectedUid(uid)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {/* Collapse/Expand Toggle */}
                          <div 
                            className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-all cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (hasChildren) toggleExpand(uid);
                            }}
                          >
                            {hasChildren ? (
                              isExpanded ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />
                            ) : (
                              <div className="w-3.5 h-3.5" />
                            )}
                          </div>

                          {/* Avatar & Title */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-extrabold text-[12px] text-slate-800 dark:text-slate-200 truncate max-w-[160px] md:max-w-[200px]">
                                {user.name || user.fullName}
                              </span>
                              <span className="text-[9px] px-1.5 py-0.2 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded font-black uppercase">
                                {user.role || 'AGENT'}
                              </span>
                            </div>
                            <div className="text-[9px] text-slate-400 font-bold truncate">
                              UID: {uid} • {user.email || 'No email'}
                            </div>
                          </div>
                        </div>

                        {/* Health Badge & Descendants Count */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {val && (
                            <span className={`text-[8px] font-black tracking-wider border rounded-full px-2 py-0.5 uppercase ${bgBadge(val.status)}`}>
                              {val.status}
                            </span>
                          )}
                          {node && node.children.length > 0 && (
                            <span className="text-[10px] font-bold text-slate-400 bg-slate-200/50 dark:bg-slate-800/50 px-1.5 py-0.5 rounded">
                              {node.children.length} reports
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

            </div>
          </div>

          {/* Right Panel: Detailed Inspector Workspace & Interactive Repair */}
          <div className="lg:col-span-5 space-y-4">
            {selectedUser ? (
              <div className={`${cardClass} border rounded-2xl p-6 shadow-sm space-y-6 animate-in fade-in duration-200`}>
                
                {/* 1. Header & Close Panel */}
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
                  <div>
                    <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest">Active Node Inspector</h4>
                    <h3 className="text-base font-black text-slate-800 dark:text-slate-100 mt-1">{selectedUser.name || selectedUser.fullName}</h3>
                  </div>
                  <button 
                    onClick={() => setSelectedUid(null)}
                    className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-600 transition-all"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* 2. User Core Information */}
                <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 dark:bg-slate-950/60 p-4 rounded-xl border border-slate-100 dark:border-slate-850/60">
                  <div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">User ID</span>
                    <div className="font-extrabold text-slate-700 dark:text-slate-300 mt-0.5 truncate">{selectedUser.uid}</div>
                  </div>
                  <div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Email Address</span>
                    <div className="font-extrabold text-slate-700 dark:text-slate-300 mt-0.5 truncate">{selectedUser.email || 'No Email'}</div>
                  </div>
                  <div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Designated Role</span>
                    <div className="font-extrabold text-slate-700 dark:text-slate-300 mt-0.5 uppercase">{selectedUser.role || 'AGENT'}</div>
                  </div>
                  <div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Assigned Process</span>
                    <div className="font-extrabold text-slate-700 dark:text-slate-300 mt-0.5 truncate">{selectedUser.process || 'Not set'}</div>
                  </div>
                </div>

                {/* 3. Real-Time Diagnostics Report */}
                {validationResults.get(selectedUid!) && (
                  <div className={`p-4 rounded-xl border flex gap-3 ${
                    (validationResults.get(selectedUid!)?.status === 'HEALTHY')
                      ? 'bg-emerald-50/50 dark:bg-emerald-950/10 border-emerald-100 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-400' 
                      : (validationResults.get(selectedUid!)?.status === 'LEGACY_RAW_REFERENCE' || validationResults.get(selectedUid!)?.status === 'MISSING_CANONICAL_UID')
                        ? 'bg-amber-50/50 dark:bg-amber-950/10 border-amber-100 dark:border-amber-900/40 text-amber-800 dark:text-amber-400'
                        : 'bg-rose-50/50 dark:bg-rose-950/10 border-rose-100 dark:border-rose-900/40 text-rose-800 dark:text-rose-400'
                  }`}>
                    {validationResults.get(selectedUid!)?.status === 'HEALTHY' ? (
                      <CheckCircle2 size={18} className="flex-shrink-0 mt-0.5 text-emerald-500" />
                    ) : (validationResults.get(selectedUid!)?.status === 'LEGACY_RAW_REFERENCE' || validationResults.get(selectedUid!)?.status === 'MISSING_CANONICAL_UID') ? (
                      <Zap size={18} className="flex-shrink-0 mt-0.5 text-amber-500" />
                    ) : (
                      <AlertTriangle size={18} className="flex-shrink-0 mt-0.5 text-rose-500" />
                    )}
                    <div className="text-xs">
                      <div className="font-black uppercase tracking-wider">System Diagnosis: {validationResults.get(selectedUid!)?.status}</div>
                      <div className="mt-1 font-extrabold">{validationResults.get(selectedUid!)?.message}</div>
                      {validationResults.get(selectedUid!)?.details && (
                        <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 font-bold">{validationResults.get(selectedUid!)?.details}</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Dedicated Canonical Reference Repair Action */}
                {(validationResults.get(selectedUid!)?.status === 'LEGACY_RAW_REFERENCE' || 
                  validationResults.get(selectedUid!)?.status === 'MISSING_CANONICAL_UID') && (
                  <div className="p-4 rounded-xl border border-amber-200/50 dark:border-amber-900/30 bg-amber-500/5 text-amber-800 dark:text-amber-400 space-y-3">
                    <div className="flex gap-2">
                      <Zap size={16} className="mt-0.5 text-amber-500" />
                      <div className="text-xs">
                        <div className="font-black uppercase tracking-wider">Automated Repair Available</div>
                        <div className="mt-1 font-bold">This relationship can be automatically canonicalized by resolving the raw text reference or writing the canonical fields directly to Firestore.</div>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        setIsSaving(true);
                        const toastId = toast.loading('Canonicalizing reporting reference...');
                        try {
                          const lookupMaps = buildAuthoritativeLookupMaps(allUsers);
                          
                          const rawTl = selectedUser.teamLeadUid || selectedUser.teamLeadId || selectedUser.tlId;
                          const rawMgr = selectedUser.mappedManagerUid || selectedUser.mappedManagerId || selectedUser.managerUid || selectedUser.managerId;

                          const resolvedTLUid = normalizeHierarchyReference(rawTl, lookupMaps);
                          const resolvedManagerUid = normalizeHierarchyReference(rawMgr, lookupMaps);

                          const hierarchyPayload = getHierarchyPersistencePayload({
                            userUid: selectedUid,
                            teamLeadUid: resolvedTLUid,
                            managerUid: resolvedManagerUid,
                            allUsers
                          });

                          const batch = writeBatch(db);
                          const userRef = doc(db, 'users', selectedUid);
                          const masterRef = doc(db, 'employee_master', selectedUid);
                          const mappingRef = doc(db, 'teamMappings', selectedUid);

                          batch.set(userRef, hierarchyPayload, { merge: true });
                          batch.set(masterRef, hierarchyPayload, { merge: true });
                          batch.set(mappingRef, hierarchyPayload, { merge: true });

                          await batch.commit();

                          const verifySnap = await getDoc(masterRef);
                          if (!verifySnap.exists()) throw new Error('Verification failed: Document does not exist after write.');
                          const vData = verifySnap.data();
                          if ((vData.teamLeadUid || '') !== (resolvedTLUid || '') || (vData.managerUid || '') !== (resolvedManagerUid || '')) {
                            throw new Error('Verification failed: DB field values do not match expected canonical payloads.');
                          }

                          await safeStorage.deleteIndexedDB(`precision360_hierarchy_nodes_${selectedUid}`);
                          await safeStorage.deleteIndexedDB(`precision360_roster_cache_${selectedUid}`);
                          await safeStorage.clearAllIndexedDBByPrefix('subordinates_');

                          toast.success('Canonical references repaired & verified successfully!', { id: toastId });
                          onRefresh();
                        } catch (err: any) {
                          console.error(err);
                          toast.error(`Auto-repair failed: ${err.message}`, { id: toastId });
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                      disabled={isSaving}
                      className="w-full bg-amber-600 hover:bg-amber-700 text-white py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <ShieldAlert size={14} />}
                      {isSaving ? 'Repairing...' : 'Repair Canonical Mapping'}
                    </button>
                  </div>
                )}

                {/* 4. Interactive Repair Controller */}
                <div className="space-y-4">
                  <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest border-b border-slate-100 dark:border-slate-800 pb-2">Repair Reporting Assignments</h4>
                  
                  {/* Team Lead Selection Box */}
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex justify-between items-center">
                      <span>Designated Team Lead (TL)</span>
                      {proposedTLUid && (
                        <button 
                          onClick={() => setProposedTLUid(null)} 
                          className="text-rose-500 hover:text-rose-700 flex items-center gap-1 font-bold lowercase text-[9px]"
                        >
                          <UserMinus size={10} /> clear assignment
                        </button>
                      )}
                    </label>
                    <div className="relative">
                      <select
                        value={proposedTLUid || ''}
                        onChange={(e) => setProposedTLUid(e.target.value || null)}
                        className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                      >
                        <option value="">(No Supervisor / Root Node)</option>
                        {eligibleSupervisors.map(u => (
                          <option key={u.uid} value={u.uid}>{u.name || u.fullName} ({u.role || 'AGENT'} • {u.uid.slice(0, 8)})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Manager Selection Box */}
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider flex justify-between items-center">
                      <span>Designated Manager</span>
                      {proposedMgrUid && (
                        <button 
                          onClick={() => setProposedMgrUid(null)} 
                          className="text-rose-500 hover:text-rose-700 flex items-center gap-1 font-bold lowercase text-[9px]"
                        >
                          <UserMinus size={10} /> clear assignment
                        </button>
                      )}
                    </label>
                    <div className="relative">
                      <select
                        value={proposedMgrUid || ''}
                        onChange={(e) => setProposedMgrUid(e.target.value || null)}
                        className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                      >
                        <option value="">(No Manager)</option>
                        {eligibleSupervisors.map(u => (
                          <option key={u.uid} value={u.uid}>{u.name || u.fullName} ({u.role || 'AGENT'} • {u.uid.slice(0, 8)})</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* 5. TMS Visibility Simulation */}
                <div className="space-y-3 bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-200/60 dark:border-slate-800/60 text-xs">
                  <h4 className="font-black text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Users size={12} className="text-indigo-500" /> Real-time TMS Visibility Simulator
                  </h4>
                  {['AGENT', 'EMPLOYEE', ''].includes((selectedUser.role || '').toString().toUpperCase().trim()) ? (
                    // Agent block
                    <div className="space-y-2 text-[11px]">
                      {selectedUser.teamLeadUid ? (
                        <div className="p-2.5 rounded bg-emerald-500/10 text-emerald-800 dark:text-emerald-400 font-extrabold border border-emerald-100 dark:border-emerald-900/30">
                          🟢 Active Supervisor Connected
                          <div className="text-[10px] text-slate-500 mt-1 font-bold">
                            Agent reports to: <span className="underline">{allUsers.find(u => u.uid === selectedUser.teamLeadUid)?.name || selectedUser.teamLeadName || selectedUser.teamLeadUid}</span>
                          </div>
                          <div className="text-[9px] text-slate-400 mt-0.5 font-medium">
                            This agent will be correctly visible in the TMS dashboard of their Team Lead & Managers.
                          </div>
                        </div>
                      ) : (
                        <div className="p-2.5 rounded bg-rose-500/10 text-rose-800 dark:text-rose-400 font-extrabold border border-rose-100 dark:border-rose-900/30 space-y-1">
                          <div className="uppercase tracking-wider">🔴 UNMAPPED / ORPHANED</div>
                          <div className="text-[10px] font-bold">Warning: Silent block: Will be invisible to the dashboard.</div>
                          <div className="text-[9px] text-slate-400 font-medium">
                            Because this agent has no supervisor UID configured, they will never resolve in any team query or appear on the TMS dashboards.
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    // Supervisor/Manager block
                    <div className="space-y-2">
                      <div className="flex justify-between items-center text-[11px] font-bold">
                        <span>Scoping Queue Size:</span>
                        <span className="font-extrabold text-indigo-600 dark:text-indigo-400">
                          {Array.from(tree.getDescendants(selectedUid)).length} users
                        </span>
                      </div>
                      
                      {Array.from(tree.getDescendants(selectedUid)).length > 0 ? (
                        <div className="border border-slate-100 dark:border-slate-800 rounded-lg max-h-36 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-900 bg-white dark:bg-slate-950">
                          {Array.from(tree.getDescendants(selectedUid)).map((id: any) => {
                            const descUser = allUsers.find(u => u.uid === id);
                            if (!descUser) return null;
                            return (
                              <div key={id} className="p-2 flex justify-between items-center text-[10px]">
                                <div className="truncate pr-2">
                                  <div className="font-extrabold text-slate-700 dark:text-slate-300">{descUser.name || descUser.fullName}</div>
                                  <div className="text-[9px] text-slate-400">{descUser.email}</div>
                                </div>
                                <span className="text-[8px] px-1.5 py-0.2 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded font-bold uppercase shrink-0">
                                  {descUser.role || 'AGENT'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="p-2.5 rounded bg-rose-500/10 text-rose-800 dark:text-rose-400 font-extrabold border border-rose-100 dark:border-rose-900/30 text-[10px]">
                          🔴 Scoping empty: This supervisor cannot see any users on their active TMS dashboard.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 6. Before vs Proposed Preview Impact Panel */}
                {repairImpact && (
                  <div className="space-y-3 bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-200/40 dark:border-slate-800/40 text-xs">
                    <h5 className="font-black text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Eye size={12} className="text-indigo-500" /> Proposed Tree Impact Preview
                    </h5>
                    
                    {repairImpact.introducesCycle ? (
                      <div className="flex gap-2 text-rose-500 bg-rose-50 dark:bg-rose-950/20 p-2.5 rounded border border-rose-100 dark:border-rose-900/30 text-[11px] font-bold">
                        <AlertCircle size={14} className="flex-shrink-0" />
                        <span>Warning: This selection would create a circular reporting link (A reports to B, who reports back to A). Repair is disabled!</span>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Summary of changes */}
                        <div className="grid grid-cols-2 gap-2 text-[11px] border-b border-slate-100 dark:border-slate-850 pb-2">
                          <div>
                            <span className="text-[9px] font-bold text-slate-400">Current Reporting</span>
                            <div className="font-extrabold text-slate-700 dark:text-slate-300">
                              TL: {selectedUser.teamLeadName || 'None'} <br/>
                              Mgr: {selectedUser.managerName || 'None'}
                            </div>
                          </div>
                          <div>
                            <span className="text-[9px] font-bold text-indigo-500">Proposed Reporting</span>
                            <div className="font-extrabold text-indigo-600 dark:text-indigo-400">
                              TL: {allUsers.find(u => u.uid === proposedTLUid)?.name || 'None'} <br/>
                              Mgr: {allUsers.find(u => u.uid === proposedMgrUid)?.name || 'None'}
                            </div>
                          </div>
                        </div>

                        {/* Affected downline and TMS changes */}
                        <div className="space-y-1.5 text-[11px]">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-slate-400">Recursive Downline Reports:</span>
                            <span className="font-extrabold text-slate-700 dark:text-slate-300">{repairImpact.downlineCount} users</span>
                          </div>
                          
                          {repairImpact.addedToTms.length > 0 && (
                            <div className="text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-500/10 p-1.5 rounded text-[10px]">
                              ➕ Will ADD {repairImpact.addedToTms.length} users to TMS dashboard scoping (e.g. {repairImpact.addedToTms.slice(0, 3).join(', ')}{repairImpact.addedToTms.length > 3 ? '...' : ''})
                            </div>
                          )}

                          {repairImpact.removedFromTms.length > 0 && (
                            <div className="text-rose-600 dark:text-rose-400 font-bold bg-rose-500/10 p-1.5 rounded text-[10px]">
                              ➖ Will REMOVE {repairImpact.removedFromTms.length} users from TMS dashboard scoping (e.g. {repairImpact.removedFromTms.slice(0, 3).join(', ')}{repairImpact.removedFromTms.length > 3 ? '...' : ''})
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 6. Authoritative Action Buttons */}
                <div className="flex gap-2">
                  <button 
                    onClick={() => setSelectedUid(null)}
                    className="flex-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleExecuteRepair}
                    disabled={isSaving || repairImpact?.introducesCycle}
                    className="flex-[2] bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <UserCheck size={14} />}
                    {isSaving ? 'Saving Repair...' : 'Authoritative Save'}
                  </button>
                </div>

              </div>
            ) : (
              <div className={`${cardClass} border rounded-2xl p-8 shadow-sm text-center text-slate-400 italic text-xs h-64 flex flex-col justify-center items-center gap-3`}>
                <Shield size={32} className="text-slate-300 dark:text-slate-700" />
                <span>Select any employee or supervisor from the interactive Org Tree to inspect their metadata, audit integrity issues, and repair reporting links.</span>
              </div>
            )}
          </div>

        </div>
      ) : (
        /* TMS Access Diagnostic Tab */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* Left panel: Diagnostic Parameters */}
          <div className="lg:col-span-5 space-y-4">
            <div className={`${cardClass} border rounded-2xl p-6 shadow-sm space-y-5`}>
              <div>
                <h3 className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-tight">Trace Dashboard Visibility</h3>
                <p className="text-xs text-slate-400 mt-1">Determine why an agent fails to appear on their supervisor&apos;s TMS dashboard with automated hierarchy routing trace diagnostics.</p>
              </div>

              {/* Actor / Supervisor Selector */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Supervisor (Actor)</label>
                <input 
                  type="text"
                  placeholder="Type name/email of supervisor..."
                  value={diagActorSearch}
                  onChange={(e) => setDiagActorSearch(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                />
                <select
                  value={diagActorUid}
                  onChange={(e) => setDiagActorUid(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                >
                  <option value="">-- Choose Supervisor --</option>
                  {filteredDiagActors.map(u => (
                    <option key={u.uid} value={u.uid}>{u.name || u.fullName} ({u.role || 'AGENT'} • {u.uid.slice(0, 8)})</option>
                  ))}
                </select>
              </div>

              {/* Target / Employee Selector */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Employee / Agent (Target)</label>
                <input 
                  type="text"
                  placeholder="Type name/email of employee..."
                  value={diagTargetSearch}
                  onChange={(e) => setDiagTargetSearch(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                />
                <select
                  value={diagTargetUid}
                  onChange={(e) => setDiagTargetUid(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 focus:outline-none"
                >
                  <option value="">-- Choose Target Employee --</option>
                  {filteredDiagTargets.map(u => (
                    <option key={u.uid} value={u.uid}>{u.name || u.fullName} ({u.role || 'AGENT'} • {u.uid.slice(0, 8)})</option>
                  ))}
                </select>
              </div>

              <button 
                onClick={handleRunDiagnosis}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2"
              >
                <PlayCircle size={14} /> Run Routing Diagnosis
              </button>
            </div>
          </div>

          {/* Right panel: Diagnostic Output Results */}
          <div className="lg:col-span-7">
            {diagnosticResult ? (
              <div className={`${cardClass} border rounded-2xl p-6 shadow-sm space-y-6 animate-in fade-in duration-200`}>
                
                {/* Status Header */}
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
                  <div>
                    <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest">Diagnosis Results</h4>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-extrabold text-slate-800 dark:text-slate-100">{diagnosticResult.actor}</span>
                      <ArrowRight size={12} className="text-slate-400" />
                      <span className="font-extrabold text-slate-800 dark:text-slate-100">{diagnosticResult.target}</span>
                    </div>
                  </div>
                  <div>
                    <span className={`text-xs font-black px-3 py-1 rounded-full border ${
                      diagnosticResult.isAccessible 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-400' 
                        : 'bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-950/20 dark:text-rose-400'
                    }`}>
                      {diagnosticResult.isAccessible ? '🟢 ACCESSIBLE IN TMS' : '🔴 INACCESSIBLE IN TMS'}
                    </span>
                  </div>
                </div>

                {/* Path Visualization */}
                <div className="space-y-2">
                  <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">Hierarchical Reporting Path</h4>
                  <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 flex flex-wrap items-center gap-2 text-xs">
                    {diagnosticResult.path.map((name: string, index: number) => (
                      <React.Fragment key={index}>
                        {index > 0 && <ChevronRight size={14} className="text-slate-400" />}
                        <span className={`font-extrabold ${index === 0 ? 'text-indigo-600 dark:text-indigo-400' : index === diagnosticResult.path.length - 1 ? 'text-slate-800 dark:text-slate-200' : 'text-slate-500'}`}>
                          {name}
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* Diagnostic Findings */}
                <div className="space-y-3">
                  <h4 className="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">Automated Diagnostics Findings</h4>
                  
                  {diagnosticResult.findings.length === 0 ? (
                    <div className="flex gap-2 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/10 border border-emerald-100 dark:border-emerald-900/30 p-4 rounded-xl text-xs font-bold">
                      <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                      <span>Diagnostics check passed! There are no broken reporting constraints or unmapped nodes between these profiles. The agent is correctly visible.</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {diagnosticResult.findings.map((f: string, i: number) => (
                        <div key={i} className="flex gap-2 text-rose-700 bg-rose-50 dark:bg-rose-950/10 border border-rose-100 dark:border-rose-900/30 p-3 rounded-xl text-xs font-bold">
                          <AlertTriangle size={16} className="text-rose-500 flex-shrink-0" />
                          <span>{f}</span>
                        </div>
                      ))}

                      {/* Diagnostic Action Recommendation */}
                      {!diagnosticResult.isAccessible && (
                        <div className="mt-4 p-4 border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/40 dark:bg-indigo-950/10 rounded-xl text-xs space-y-3">
                          <div className="font-extrabold text-indigo-700 dark:text-indigo-400 flex items-center gap-1.5">
                            <Info size={14} /> Quick Action Recommendation
                          </div>
                          <p className="text-slate-500 dark:text-slate-400">
                            To fix this dashboard visibility block, you can open the target employee in the Org Tree Inspector and repair their Team Lead or Manager assignments to link them back to this supervisor&apos;s reporting line.
                          </p>
                          <button 
                            onClick={() => {
                              setSelectedUid(diagTargetUid);
                              setActiveTab('inspector');
                            }}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-black uppercase text-[10px] tracking-wider transition-all"
                          >
                            Repair reporting line for {diagnosticResult.target}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

              </div>
            ) : (
              <div className={`${cardClass} border rounded-2xl p-8 shadow-sm text-center text-slate-400 italic text-xs h-64 flex flex-col justify-center items-center gap-3`}>
                <Users size={32} className="text-slate-300 dark:text-slate-700" />
                <span>Specify a supervisor and an employee profile, then click Routing Diagnosis to inspect reporting paths, visibility rules, and access errors in real time.</span>
              </div>
            )}
          </div>

        </div>
      )}

      </>
    )}

      {/* Bulk Hierarchy Repair Modal */}
      <BulkHierarchyRepairModal
        isOpen={isBulkModalOpen}
        onClose={() => setIsBulkModalOpen(false)}
        allUsers={allUsers}
        adminTheme={adminTheme}
        onRefresh={onRefresh}
        logAdminEvent={logAdminEvent}
      />

      <IdentityNormalizationModal
        isOpen={isIdentityModalOpen}
        onClose={() => setIsIdentityModalOpen(false)}
        allUsers={allUsers}
        adminTheme={adminTheme}
        onRefresh={onRefresh}
        logAdminEvent={logAdminEvent}
      />

    </div>
  );
};
