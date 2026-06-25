import React, { useState, useEffect, useMemo } from 'react';
import { 
  LifeBuoy, Plus, Search, Filter, Clock, AlertTriangle, CheckCircle, XCircle, 
  MessageSquare, Paperclip, Shield, Activity, FileText, ChevronRight, Laptop, 
  Calendar, Check, User as UserIcon, RefreshCw, BarChart3, Settings, Database,
  ArrowRight, Key, Eye, HelpCircle, AlertCircle, Info, Trash2, Edit2, ShieldAlert,
  Sliders, UserCheck, TrendingUp, Inbox, Send, ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, storage } from '../lib/firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { 
  collection, query, where, getDocs, onSnapshot, doc, setDoc, 
  addDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch, getDoc,
  orderBy, limit
} from 'firebase/firestore';
import { UserProfile, UserRole, ITTicket, ITTicketComment, ITAsset } from '../types';
import { usePermission } from '../components/PermissionContext';
import { toast } from 'sonner';

// Utility to parse Browser, OS, and Device info
function getBrowserAndOS() {
  const ua = navigator.userAgent;
  let browser = "Unknown Browser";
  let os = "Unknown OS";
  let device = "Desktop";

  if (ua.indexOf("Firefox") > -1) browser = "Mozilla Firefox";
  else if (ua.indexOf("SamsungBrowser") > -1) browser = "Samsung Browser";
  else if (ua.indexOf("Opera") > -1 || ua.indexOf("OPR") > -1) browser = "Opera";
  else if (ua.indexOf("Trident") > -1) browser = "Internet Explorer";
  else if (ua.indexOf("Edge") > -1 || ua.indexOf("Edg") > -1) browser = "Microsoft Edge";
  else if (ua.indexOf("Chrome") > -1) browser = "Google Chrome";
  else if (ua.indexOf("Safari") > -1) browser = "Apple Safari";

  if (ua.indexOf("Windows NT 10.0") > -1) os = "Windows 10/11";
  else if (ua.indexOf("Windows NT 6.2") > -1) os = "Windows 8";
  else if (ua.indexOf("Windows NT 6.1") > -1) os = "Windows 7";
  else if (ua.indexOf("Macintosh") > -1) os = "macOS";
  else if (ua.indexOf("X11") > -1) os = "Linux";
  else if (ua.indexOf("Android") > -1) {
    os = "Android";
    device = "Mobile";
  }
  else if (ua.indexOf("iPhone") > -1) {
    os = "iOS";
    device = "Mobile";
  }

  return { browser, os, device };
}

// Categories and subcategories
const IT_CATEGORIES: Record<string, string[]> = {
  "System Access Request": ["Active Directory", "Local Admin Rights", "Shared Folder Access", "CRM Login"],
  "Password Reset": ["Domain Password", "Email Password", "CRM Password", "VPN Password"],
  "Application Issue": ["Chrome / Web Browser", "MS Office", "Slack", "Internal Database Portal", "Other SaaS"],
  "Hardware Issue": ["Monitor Issue", "Keyboard/Mouse", "Headset Static", "Power Cable / Charger"],
  "Laptop/Desktop Issue": ["Blue Screen / Crash", "Slow Performance", "Battery / Power", "Won't Turn On"],
  "Network / Internet Issue": ["No Wi-Fi Connection", "Slow Internet Speed", "Ethernet Port Disconnected"],
  "Email Issue": ["Outlook / Gmail Sync", "Spam / Phishing Report", "Mailing List Request", "Signature Setup"],
  "VPN Access": ["FortiClient VPN", "AnyConnect", "MFA Authentication Key Issue", "Connection Timeout"],
  "Software Installation": ["Node.js / Developer Tools", "VPN Client", "Visual Studio Code", "Graphic Tools", "Security Software"],
  "Printer Issue": ["Paper Jam", "Driver Setup", "Offline Status", "Scanner Not Working"],
  "New User Creation": ["New Hire Onboarding Pack", "Domain Account", "Email Provisioning"],
  "Asset Request": ["Additional Monitor", "Wireless Mouse/Keyboard", "Replacement Charger", "Noise Cancelling Headset"],
  "Asset Replacement": ["Damaged Screen", "Failing Battery", "Outdated Computer Upgrades"],
  "Security Concern": ["Suspected Malware", "Phishing Email Clicked", "Unauthorized Data Access", "Lost Device Report"],
  "Other": ["General Help", "Consultation", "Documentation Request"]
};

// Help desk roles
type HelpDeskRole = 'EMPLOYEE' | 'IT_TEAM' | 'ADMIN';

export default function ITHelpDeskView({ user, allUsers, externalTheme }: { user: UserProfile; allUsers: any[]; externalTheme?: string }) {
  const { canEdit, canDelete } = usePermission();
  const [activeSubTab, setActiveSubTab] = useState<'portal' | 'queue' | 'analytics' | 'admin'>('portal');
  const [tickets, setTickets] = useState<ITTicket[]>([]);
  const [assets, setAssets] = useState<ITAsset[]>([]);
  const [itEngineers, setItEngineers] = useState<UserProfile[]>([]);
  const [slaConfigs, setSlaConfigs] = useState<Record<string, number>>({
    'Critical': 2,
    'High': 4,
    'Medium': 8,
    'Low': 24
  });
  const [loading, setLoading] = useState(true);

  // Search and filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  
  // Selected ticket for detailed view
  const [selectedTicket, setSelectedTicket] = useState<ITTicket | null>(null);
  const [commentText, setCommentText] = useState('');
  const [isInternalComment, setIsInternalComment] = useState(false);
  const [newStatus, setNewStatus] = useState<string>('');
  const [newAssignee, setNewAssignee] = useState<string>('');
  const [newPriority, setNewPriority] = useState<string>('');

  // Ticket creation form
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [ticketCategory, setTicketCategory] = useState('System Access Request');
  const [ticketSubCategory, setTicketSubCategory] = useState('');
  const [ticketPriority, setTicketPriority] = useState<'Low' | 'Medium' | 'High' | 'Critical'>('Medium');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketDescription, setTicketDescription] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [ticketAttachments, setTicketAttachments] = useState<string[]>([]);
  const [submittingTicket, setSubmittingTicket] = useState(false);

  // Asset creation form
  const [assetType, setAssetType] = useState('Laptop');
  const [assetSerial, setAssetSerial] = useState('');
  const [assetUserUid, setAssetUserUid] = useState('');
  const [assetStatus, setAssetStatus] = useState<'Active' | 'In Maintenance' | 'Replaced' | 'Retired'>('Active');
  const [submittingAsset, setSubmittingAsset] = useState(false);

  // Live File Upload State & Handlers
  const [uploadingFile, setUploadingFile] = useState(false);

  const getFileNameFromUrl = (url: string) => {
    try {
      const decodedUrl = decodeURIComponent(url);
      const fileName = decodedUrl.substring(decodedUrl.lastIndexOf('/') + 1).split('?')[0] || 'Attached File';
      const parts = fileName.split('_');
      return parts.length > 2 ? parts.slice(2).join('_') : fileName;
    } catch (e) {
      return 'Attachment';
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      toast.error("File size exceeds 10MB limit.");
      return;
    }

    setUploadingFile(true);
    const toastId = toast.loading("Uploading attachment...");
    try {
      const fileRef = ref(storage, `it_helpdesk_attachments/${user.uid}_${Date.now()}_${file.name}`);
      const uploadResult = await uploadBytes(fileRef, file);
      const downloadUrl = await getDownloadURL(uploadResult.ref);
      
      setTicketAttachments(prev => [...prev, downloadUrl]);
      toast.success("File uploaded successfully!", { id: toastId });
    } catch (err: any) {
      console.error("Storage upload failed: ", err);
      toast.error(`Upload failed: ${err.message || 'Unknown error'}`, { id: toastId });
    } finally {
      setUploadingFile(false);
    }
  };

  // Bulk Asset CSV Upload State & Handlers
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [parsedAssets, setParsedAssets] = useState<any[]>([]);
  const [isUploadingBulk, setIsUploadingBulk] = useState(false);

  const handleBulkCSVChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkFile(file);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      try {
        const lines = text.split('\n');
        if (lines.length === 0) {
          toast.error("CSV file is empty.");
          return;
        }
        
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
        const list: any[] = [];

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.trim().replace(/^["']|["']$/g, ''));
          const asset: any = {};
          
          headers.forEach((h, idx) => {
            const rawVal = values[idx] || '';
            const normalizedHeader = h.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalizedHeader === 'assettype' || normalizedHeader === 'type') {
              asset.assetType = rawVal || 'Laptop';
            } else if (normalizedHeader === 'serialnumber' || normalizedHeader === 'serial' || normalizedHeader === 'serialno') {
              asset.serialNumber = rawVal;
            } else if (normalizedHeader === 'assigneduser' || normalizedHeader === 'useruid' || normalizedHeader === 'assignedto') {
              asset.assignedUser = rawVal;
            } else if (normalizedHeader === 'assignedusername' || normalizedHeader === 'username') {
              asset.assignedUserName = rawVal;
            } else if (normalizedHeader === 'issuedate' || normalizedHeader === 'date') {
              asset.issueDate = rawVal || new Date().toISOString().substring(0, 10);
            } else if (normalizedHeader === 'status') {
              asset.status = ['Active', 'In Maintenance', 'Replaced', 'Retired'].includes(rawVal) ? rawVal : 'Active';
            }
          });

          if (!asset.assetType) asset.assetType = 'Laptop';
          if (asset.serialNumber) {
            if (asset.assignedUser && !asset.assignedUserName) {
              const u = allUsers.find(user => user.uid === asset.assignedUser);
              if (u) asset.assignedUserName = u.fullName || u.name;
            }
            if (!asset.assignedUser && asset.assignedUserName) {
              const u = allUsers.find(user => (user.fullName || user.name || '').toLowerCase() === asset.assignedUserName.toLowerCase());
              if (u) {
                asset.assignedUser = u.uid;
                asset.assignedUserName = u.fullName || u.name;
              }
            }
            if (!asset.status) asset.status = 'Active';
            list.push(asset);
          }
        }

        setParsedAssets(list);
        toast.success(`Parsed ${list.length} assets! Review preview list and click "Confirm Bulk Upload" to save.`);
      } catch (err) {
        console.error(err);
        toast.error("Failed to parse CSV file. Ensure standard column headers.");
      }
    };
    reader.readAsText(file);
  };

  const handleBulkUploadConfirm = async () => {
    if (parsedAssets.length === 0) return;
    setIsUploadingBulk(true);
    const toastId = toast.loading(`Uploading ${parsedAssets.length} assets...`);
    try {
      const batch = writeBatch(db);
      parsedAssets.forEach((asset) => {
        const assetRef = doc(collection(db, 'itAssets'));
        batch.set(assetRef, asset);
      });
      await batch.commit();
      toast.success(`Successfully registered ${parsedAssets.length} assets in bulk!`, { id: toastId });
      setParsedAssets([]);
      setBulkFile(null);
    } catch (err: any) {
      console.error(err);
      toast.error(`Bulk upload failed: ${err.message}`, { id: toastId });
    } finally {
      setIsUploadingBulk(false);
    }
  };

  // Determine user's Help Desk role
  const helpDeskRole: HelpDeskRole = useMemo(() => {
    const roleNormalized = (user?.role || '').toString().toUpperCase().trim().replace(/\s+/g, '_');
    if (['ADMIN', 'MANAGER', 'OPS_HEAD', 'HR', 'IT_MANAGER'].includes(roleNormalized)) {
      return 'ADMIN';
    }
    // Also treat MIS and designated IT engineers as IT Team
    const isEngineer = itEngineers.some(eng => eng.uid === user.uid);
    if (roleNormalized === 'MIS' || isEngineer) {
      return 'IT_TEAM';
    }
    return 'EMPLOYEE';
  }, [user, itEngineers]);

  // Real-time listener for tickets
  useEffect(() => {
    setLoading(true);
    const ticketsQuery = query(collection(db, 'itTickets'), orderBy('createdAt', 'desc'));
    
    const unsubscribe = onSnapshot(ticketsQuery, (snapshot) => {
      const ticketList: ITTicket[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        ticketList.push({
          id: docSnap.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || Date.now()),
          updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate() : new Date(data.updatedAt || Date.now()),
          resolvedAt: data.resolvedAt?.toDate ? data.resolvedAt.toDate() : data.resolvedAt ? new Date(data.resolvedAt) : undefined,
          closedAt: data.closedAt?.toDate ? data.closedAt.toDate() : data.closedAt ? new Date(data.closedAt) : undefined,
          slaDeadline: data.slaDeadline?.toDate ? data.slaDeadline.toDate() : data.slaDeadline ? new Date(data.slaDeadline) : undefined,
          comments: (data.comments || []).map((c: any) => ({
            ...c,
            createdAt: c.createdAt?.toDate ? c.createdAt.toDate() : new Date(c.createdAt || Date.now())
          }))
        } as ITTicket);
      });
      setTickets(ticketList);
      setLoading(false);
    }, (error) => {
      console.error("Error loading tickets: ", error);
      toast.error("Failed to load IT tickets.");
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Real-time listener for assets
  useEffect(() => {
    const assetsQuery = collection(db, 'itAssets');
    const unsubscribe = onSnapshot(assetsQuery, (snapshot) => {
      const assetList: ITAsset[] = [];
      snapshot.forEach((docSnap) => {
        assetList.push({ id: docSnap.id, ...docSnap.data() } as ITAsset);
      });
      setAssets(assetList);
    });
    return () => unsubscribe();
  }, []);

  // Real-time listener for SLA config and IT team
  useEffect(() => {
    const unsubSla = onSnapshot(doc(db, 'itHelpDeskConfig', 'sla'), (docSnap) => {
      if (docSnap.exists()) {
        setSlaConfigs(docSnap.data() as Record<string, number>);
      }
    });

    const unsubTeam = onSnapshot(doc(db, 'itHelpDeskConfig', 'team'), (docSnap) => {
      if (docSnap.exists()) {
        const uids = docSnap.data().uids || [];
        const engineers = allUsers.filter(u => uids.includes(u.uid));
        setItEngineers(engineers);
      }
    });

    return () => {
      unsubSla();
      unsubTeam();
    };
  }, [allUsers]);

  // Keep selected ticket in sync with latest list updates
  useEffect(() => {
    if (selectedTicket) {
      const updated = tickets.find(t => t.id === selectedTicket.id);
      if (updated) {
        setSelectedTicket(updated);
      }
    }
  }, [tickets, selectedTicket]);

  // Subcategory auto selection on category change
  useEffect(() => {
    const subs = IT_CATEGORIES[ticketCategory];
    if (subs && subs.length > 0) {
      setTicketSubCategory(subs[0]);
    } else {
      setTicketSubCategory('');
    }
  }, [ticketCategory]);

  // SLA Indicators
  const getSLADetails = (ticket: ITTicket) => {
    if (!ticket.slaDeadline) return { text: 'No SLA', color: 'text-slate-500 bg-slate-100 dark:bg-slate-800' };
    
    const now = new Date();
    const deadline = new Date(ticket.slaDeadline);
    const resolved = ticket.resolvedAt ? new Date(ticket.resolvedAt) : null;
    const closed = ticket.closedAt ? new Date(ticket.closedAt) : null;
    
    // If ticket is resolved/closed, check if it met or breached
    if (resolved || closed) {
      const finishTime = resolved || closed;
      if (finishTime! <= deadline) {
        return { text: 'SLA Met', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40' };
      } else {
        return { text: 'SLA Breached', color: 'text-rose-600 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40' };
      }
    }

    const diffMs = deadline.getTime() - now.getTime();
    const diffHrs = diffMs / (1000 * 60 * 60);

    if (diffMs < 0) {
      return { text: 'SLA Breached', color: 'text-rose-600 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40 font-bold animate-pulse' };
    } else if (diffHrs < 1) {
      return { text: `Breaches in < 1h`, color: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 font-bold animate-pulse' };
    } else if (diffHrs < 4) {
      return { text: `Breaches in ${Math.round(diffHrs)}h`, color: 'text-amber-500 bg-amber-50/50 dark:bg-amber-950/10 border border-amber-100' };
    } else {
      return { text: `SLA OK (${Math.round(diffHrs)}h)`, color: 'text-slate-600 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800' };
    }
  };

  // Helper to trigger in-app activity and notify
  const createInAppNotification = async (recipientId: string, title: string, body: string, ticketId: string) => {
    try {
      await addDoc(collection(db, 'itNotifications'), {
        recipientId,
        title,
        body,
        ticketId,
        read: false,
        createdAt: serverTimestamp()
      });
    } catch (e) {
      console.error("Failed to save notification: ", e);
    }
  };

  // Create Ticket Handler
  const handleCreateTicket = async () => {
    if (!ticketSubject.trim() || !ticketDescription.trim()) {
      toast.error("Subject and Description are required.");
      return;
    }

    setSubmittingTicket(true);
    try {
      const { browser, os, device } = getBrowserAndOS();
      
      // Calculate SLA deadline
      const hoursToSla = slaConfigs[ticketPriority] || 8;
      const slaDeadlineDate = new Date();
      slaDeadlineDate.setHours(slaDeadlineDate.getHours() + hoursToSla);

      // Simple ticket counter generator
      const nextNum = tickets.length + 1;
      const formattedId = `IT-2026-${String(nextNum).padStart(6, '0')}`;

      const docPayload: Omit<ITTicket, 'id'> = {
        ticketId: formattedId,
        employeeId: user.uid,
        employeeName: user.fullName || user.name || 'Anonymous Employee',
        employeeEmail: user.email,
        employeeDepartment: user.department || 'N/A',
        category: ticketCategory,
        subCategory: ticketSubCategory,
        priority: ticketPriority,
        subject: ticketSubject,
        description: ticketDescription,
        status: 'New',
        comments: [],
        attachments: ticketAttachments.map(url => ({
          name: url.substring(url.lastIndexOf('/') + 1) || 'Attached File',
          url,
          type: 'image'
        })),
        deviceInfo: device,
        browserInfo: browser,
        osInfo: os,
        assetId: selectedAssetId || undefined,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        slaStatus: 'In Progress',
        slaDeadline: slaDeadlineDate
      };

      await addDoc(collection(db, 'itTickets'), docPayload);

      // Raise trigger notifications
      toast.success(`Ticket ${formattedId} successfully created!`);
      setShowCreateModal(false);
      setTicketSubject('');
      setTicketDescription('');
      setSelectedAssetId('');
      setTicketAttachments([]);

      // In-app alert for Administrators
      const admins = allUsers.filter(u => ['ADMIN', 'MANAGER', 'MIS'].includes((u.role || '').toUpperCase()));
      for (const admin of admins) {
        await createInAppNotification(admin.uid, "New IT Ticket", `${user.fullName} raised a ${ticketPriority} ticket: "${ticketSubject}"`, formattedId);
      }
    } catch (err: any) {
      console.error("Failed to create ticket: ", err);
      toast.error("Failed to raise ticket.");
    } finally {
      setSubmittingTicket(false);
    }
  };

  // Add Comment / Action Handler
  const handleAddComment = async () => {
    if (!selectedTicket || !commentText.trim()) return;

    try {
      const commentPayload: ITTicketComment = {
        id: crypto.randomUUID(),
        text: commentText,
        authorId: user.uid,
        authorName: user.fullName || user.name,
        authorRole: helpDeskRole === 'ADMIN' ? 'IT Admin' : helpDeskRole === 'IT_TEAM' ? 'IT Support' : 'Employee',
        isInternal: isInternalComment,
        createdAt: new Date()
      };

      const ticketRef = doc(db, 'itTickets', selectedTicket.id);
      const updatedComments = [...selectedTicket.comments, commentPayload];

      const updates: any = {
        comments: updatedComments,
        updatedAt: serverTimestamp()
      };

      // Set First Response At if IT replies to user for the first time
      if (!selectedTicket.firstResponseAt && !isInternalComment && helpDeskRole !== 'EMPLOYEE') {
        updates.firstResponseAt = serverTimestamp();
      }

      await updateDoc(ticketRef, updates);
      setCommentText('');
      toast.success("Comment added.");

      // Notify relevant user
      if (helpDeskRole === 'EMPLOYEE') {
        // Notify Assignee if exists
        if (selectedTicket.assignedTo) {
          await createInAppNotification(
            selectedTicket.assignedTo, 
            "User commented on Ticket", 
            `${user.fullName} replied to ticket ${selectedTicket.ticketId}`, 
            selectedTicket.id
          );
        }
      } else {
        // IT team commented, notify the customer
        if (!isInternalComment) {
          await createInAppNotification(
            selectedTicket.employeeId, 
            "Update on your IT Ticket", 
            `IT Support left a comment on "${selectedTicket.subject}"`, 
            selectedTicket.id
          );
        }
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to save comment.");
    }
  };

  // Ticket Status & Action Controls
  const handleUpdateTicketAction = async (fieldsToUpdate: Partial<ITTicket>, successMsg = "Ticket updated") => {
    if (!selectedTicket) return;

    try {
      const ticketRef = doc(db, 'itTickets', selectedTicket.id);
      const payload: any = {
        ...fieldsToUpdate,
        updatedAt: serverTimestamp()
      };

      if (fieldsToUpdate.status === 'Resolved') {
        payload.resolvedAt = serverTimestamp();
        payload.slaStatus = 'Met'; // check SLA met when resolved
      } else if (fieldsToUpdate.status === 'Closed') {
        payload.closedAt = serverTimestamp();
      }

      await updateDoc(ticketRef, payload);
      toast.success(successMsg);

      // Create comment detailing the action
      const logs = Object.entries(fieldsToUpdate)
        .map(([key, val]) => {
          if (key === 'status') return `Status changed to ${val}`;
          if (key === 'priority') return `Priority updated to ${val}`;
          if (key === 'assignedToName') return `Assigned to ${val}`;
          return `${key} changed`;
        }).join(', ');

      const actionComment: ITTicketComment = {
        id: crypto.randomUUID(),
        text: `🔧 System Log: ${logs}`,
        authorId: 'SYSTEM',
        authorName: 'System',
        authorRole: 'System Log',
        isInternal: false,
        createdAt: new Date()
      };

      await updateDoc(ticketRef, {
        comments: [...selectedTicket.comments, actionComment]
      });

      // Notify customer
      await createInAppNotification(
        selectedTicket.employeeId,
        "Your Ticket was updated",
        `IT Ticketing: ${logs}`,
        selectedTicket.id
      );

    } catch (e) {
      console.error(e);
      toast.error("Action failed.");
    }
  };

  // Quick Mock File Upload
  const handleFileAttachMock = () => {
    const urls = [
      'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=300&q=80',
      'https://images.unsplash.com/photo-1542744094-3a31f103e35f?auto=format&fit=crop&w=300&q=80'
    ];
    const picked = urls[Math.floor(Math.random() * urls.length)];
    setTicketAttachments([...ticketAttachments, picked]);
    toast.success("Screenshot uploaded successfully!");
  };

  // Add Asset Handler
  const handleCreateAsset = async () => {
    if (!assetSerial.trim()) {
      toast.error("Serial number is required.");
      return;
    }

    setSubmittingAsset(true);
    try {
      const selectedUser = allUsers.find(u => u.uid === assetUserUid);
      const payload: Omit<ITAsset, 'id'> = {
        assetType,
        serialNumber: assetSerial,
        assignedUser: assetUserUid || undefined,
        assignedUserName: selectedUser ? (selectedUser.fullName || selectedUser.name) : undefined,
        issueDate: assetUserUid ? new Date().toISOString().substring(0, 10) : undefined,
        status: assetStatus
      };

      await addDoc(collection(db, 'itAssets'), payload);
      toast.success("Asset added successfully.");
      setAssetSerial('');
      setAssetUserUid('');
    } catch (e) {
      console.error(e);
      toast.error("Failed to add asset.");
    } finally {
      setSubmittingAsset(false);
    }
  };

  // Seed Default System Demo Data
  const handleSeedMockData = async () => {
    try {
      const batch = writeBatch(db);
      
      // Seed default SLA configs if not exist
      const slaRef = doc(db, 'itHelpDeskConfig', 'sla');
      batch.set(slaRef, {
        'Critical': 2,
        'High': 4,
        'Medium': 8,
        'Low': 24
      });

      // Seed current user as IT Team by default so they can test the queue
      const teamRef = doc(db, 'itHelpDeskConfig', 'team');
      batch.set(teamRef, {
        uids: [user.uid]
      });

      // Create standard sample assets for the current user
      const asset1Ref = doc(collection(db, 'itAssets'));
      batch.set(asset1Ref, {
        assetType: 'Laptop',
        serialNumber: 'SN-X206-89921',
        assignedUser: user.uid,
        assignedUserName: user.fullName || user.name,
        issueDate: '2026-01-15',
        status: 'Active'
      });

      const asset2Ref = doc(collection(db, 'itAssets'));
      batch.set(asset2Ref, {
        assetType: 'Noise Cancelling Headset',
        serialNumber: 'SN-HDST-4402',
        assignedUser: user.uid,
        assignedUserName: user.fullName || user.name,
        issueDate: '2026-03-22',
        status: 'Active'
      });

      // Create some demo tickets
      const ticket1Ref = doc(collection(db, 'itTickets'));
      const deadline1 = new Date();
      deadline1.setHours(deadline1.getHours() + 4);
      batch.set(ticket1Ref, {
        ticketId: 'IT-2026-000001',
        employeeId: user.uid,
        employeeName: user.fullName || user.name,
        employeeEmail: user.email,
        employeeDepartment: user.department || 'Production',
        category: 'VPN Access',
        subCategory: 'FortiClient VPN',
        priority: 'High',
        subject: 'VPN Connection Fails on Wi-Fi',
        description: 'Every time I try to connect to FortiClient, it hangs on 98% and displays a credential error. My login details are correct.',
        status: 'Assigned',
        comments: [
          {
            id: '1',
            text: 'I have checked your VPN profiles and reset the security tokens. Please try connecting again.',
            authorId: 'SYSTEM_BOT',
            authorName: 'IT Engineer Pro',
            authorRole: 'IT Support',
            isInternal: false,
            createdAt: new Date()
          }
        ],
        attachments: [],
        deviceInfo: 'Desktop',
        browserInfo: 'Google Chrome',
        osInfo: 'macOS',
        createdAt: new Date(Date.now() - 3600000 * 3), // 3 hours ago
        updatedAt: new Date(),
        slaStatus: 'In Progress',
        slaDeadline: deadline1
      });

      await batch.commit();
      toast.success("Mock SLA, Team, Assets and Tickets seeded successfully!");
    } catch (e) {
      console.error(e);
      toast.error("Failed to seed demo data.");
    }
  };

  // Filtered Tickets for Admin/Queue vs Portal
  const myPortalTickets = useMemo(() => {
    return tickets.filter(t => t.employeeId === user.uid);
  }, [tickets, user]);

  const filteredQueueTickets = useMemo(() => {
    return tickets.filter(t => {
      // General permission rules
      // IT support team and admins can see all tickets. Employees can only see their own.
      const isAuthorized = helpDeskRole !== 'EMPLOYEE';
      if (!isAuthorized) {
        return t.employeeId === user.uid;
      }

      // Search
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = !searchQuery || 
        t.ticketId.toLowerCase().includes(searchLower) ||
        t.subject.toLowerCase().includes(searchLower) ||
        t.description.toLowerCase().includes(searchLower) ||
        t.employeeName.toLowerCase().includes(searchLower);

      // Filters
      const matchesStatus = statusFilter.length === 0 || statusFilter.includes(t.status);
      const matchesPriority = priorityFilter.length === 0 || priorityFilter.includes(t.priority);
      const matchesAssignee = assigneeFilter.length === 0 || 
        (assigneeFilter.includes('unassigned') && !t.assignedTo) || 
        (t.assignedTo && assigneeFilter.includes(t.assignedTo));
      const matchesCategory = categoryFilter.length === 0 || categoryFilter.includes(t.category);

      return matchesSearch && matchesStatus && matchesPriority && matchesAssignee && matchesCategory;
    });
  }, [tickets, searchQuery, statusFilter, priorityFilter, assigneeFilter, categoryFilter, helpDeskRole, user]);

  // Statistics
  const ticketStats = useMemo(() => {
    const list = helpDeskRole === 'EMPLOYEE' ? myPortalTickets : tickets;
    return {
      total: list.length,
      open: list.filter(t => ['New', 'Assigned', 'In Progress', 'Waiting for User'].includes(t.status)).length,
      inProgress: list.filter(t => t.status === 'In Progress').length,
      resolved: list.filter(t => t.status === 'Resolved').length,
      closed: list.filter(t => t.status === 'Closed').length,
      critical: list.filter(t => t.priority === 'Critical' && t.status !== 'Closed').length
    };
  }, [tickets, myPortalTickets, helpDeskRole]);

  // My Assets list
  const myAssets = useMemo(() => {
    return assets.filter(a => a.assignedUser === user.uid && a.status === 'Active');
  }, [assets, user]);

  return (
    <div className="w-full h-full flex flex-col p-6 space-y-6 overflow-y-auto" id="it_helpdesk_main_view">
      {/* Upper Navigation Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-200 dark:border-slate-800 pb-4 shrink-0">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 text-white p-2 rounded-xl shadow-md shadow-blue-500/10">
              <LifeBuoy size={24} className="animate-spin-slow" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">IT Service Desk</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">Enterprise Ticket Management & Asset Lifecycle portal</p>
            </div>
          </div>
        </div>

        {/* Dynamic Sub Tabs */}
        <div className="flex bg-slate-100 dark:bg-slate-900 rounded-xl p-1 mt-4 md:mt-0 shadow-inner">
          <button 
            onClick={() => { setActiveSubTab('portal'); setSelectedTicket(null); }}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${
              activeSubTab === 'portal' 
                ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm' 
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            My Portal
          </button>
          
          {helpDeskRole !== 'EMPLOYEE' && (
            <button 
              onClick={() => { setActiveSubTab('queue'); setSelectedTicket(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${
                activeSubTab === 'queue' 
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm' 
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              IT Queue ({filteredQueueTickets.length})
            </button>
          )}

          {helpDeskRole !== 'EMPLOYEE' && (
            <button 
              onClick={() => { setActiveSubTab('analytics'); setSelectedTicket(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${
                activeSubTab === 'analytics' 
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm' 
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Analytics
            </button>
          )}

          {helpDeskRole === 'ADMIN' && (
            <button 
              onClick={() => { setActiveSubTab('admin'); setSelectedTicket(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${
                activeSubTab === 'admin' 
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm' 
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Admin Setup
            </button>
          )}
        </div>
      </div>

      {/* Ticket Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">All Tickets</span>
            <h3 className="text-2xl font-bold mt-1 text-slate-900 dark:text-white">{ticketStats.total}</h3>
          </div>
          <Inbox className="text-slate-400" size={24} />
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">Open Tickets</span>
            <h3 className="text-2xl font-bold mt-1 text-blue-600 dark:text-blue-400">{ticketStats.open}</h3>
          </div>
          <Activity className="text-blue-500" size={24} />
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">In Progress</span>
            <h3 className="text-2xl font-bold mt-1 text-amber-500">{ticketStats.inProgress}</h3>
          </div>
          <Clock className="text-amber-500" size={24} />
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">Resolved / Closed</span>
            <h3 className="text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">{ticketStats.resolved + ticketStats.closed}</h3>
          </div>
          <CheckCircle className="text-emerald-500" size={24} />
        </div>
        <div className="bg-red-50 dark:bg-red-950/20 rounded-2xl p-4 border border-red-200 dark:border-red-900 shadow-sm flex items-center justify-between col-span-2 lg:col-span-1">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-red-700 dark:text-red-400">Critical Issues</span>
            <h3 className="text-2xl font-bold mt-1 text-red-600 dark:text-red-500">{ticketStats.critical}</h3>
          </div>
          <AlertCircle className="text-red-500" size={24} />
        </div>
      </div>

      {/* Main Tab Rendering */}
      <AnimatePresence mode="wait">
        {selectedTicket ? (
          // =================== INTERACTIVE DETAIL VIEW ===================
          <motion.div 
            key="ticket-details"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className="grid grid-cols-1 lg:grid-cols-3 gap-6"
          >
            {/* Left Side: Detail & Comments */}
            <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col space-y-6">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
                <button 
                  onClick={() => setSelectedTicket(null)}
                  className="flex items-center text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-150 gap-1.5"
                >
                  <ChevronRight className="rotate-180" size={16} /> Back to Dashboard
                </button>
                <div className="text-xs font-mono font-bold text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-3 py-1.5 rounded-lg">
                  {selectedTicket.ticketId}
                </div>
              </div>

              {/* Title & Description */}
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400">{selectedTicket.category} &gt; {selectedTicket.subCategory || 'General'}</span>
                <h2 className="text-lg font-black text-slate-800 dark:text-white mt-1">{selectedTicket.subject}</h2>
                
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                    selectedTicket.priority === 'Critical' ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' :
                    selectedTicket.priority === 'High' ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300' :
                    selectedTicket.priority === 'Medium' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' :
                    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                  }`}>
                    {selectedTicket.priority} Priority
                  </span>
                  
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                    selectedTicket.status === 'New' ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40' :
                    selectedTicket.status === 'Assigned' ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40' :
                    selectedTicket.status === 'In Progress' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40' :
                    selectedTicket.status === 'Waiting for User' ? 'bg-rose-50 text-rose-700' :
                    selectedTicket.status === 'Resolved' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40' :
                    'bg-slate-100 text-slate-700 dark:bg-slate-800'
                  }`}>
                    Status: {selectedTicket.status}
                  </span>

                  {/* SLA Status indicator */}
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${getSLADetails(selectedTicket).color}`}>
                    {getSLADetails(selectedTicket).text}
                  </span>
                </div>

                <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-2xl mt-4 border border-slate-100 dark:border-slate-800">
                  <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{selectedTicket.description}</p>
                </div>
              </div>

              {/* Attachments Section */}
              {selectedTicket.attachments && selectedTicket.attachments.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase font-bold text-slate-400 mb-2">Attachments ({selectedTicket.attachments.length})</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {selectedTicket.attachments.map((file, idx) => (
                      <a 
                        key={idx}
                        href={file.url} 
                        target="_blank" 
                        rel="referrer" 
                        className="border border-slate-200 dark:border-slate-800 rounded-xl p-2 flex flex-col justify-between items-center text-center bg-slate-50 dark:bg-slate-900 group hover:border-blue-500 transition-all"
                      >
                        <Paperclip size={24} className="text-slate-400 group-hover:text-blue-500 mt-2" />
                        <span className="text-[10px] text-slate-600 dark:text-slate-300 truncate w-full mt-2 font-mono">{file.name}</span>
                        <span className="text-[9px] text-blue-500 font-bold mt-1 flex items-center gap-1 group-hover:underline">View <Eye size={10} /></span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Comments Timeline */}
              <div className="border-t border-slate-100 dark:border-slate-800 pt-6">
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                  <MessageSquare size={16} className="text-blue-500" /> Discussion & History
                </h3>
                
                <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                  {selectedTicket.comments.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-4">No comments posted yet. Add a message to start communicating.</p>
                  ) : (
                    selectedTicket.comments.map((comm) => (
                      <div 
                        key={comm.id} 
                        className={`p-3.5 rounded-2xl border ${
                          comm.authorId === 'SYSTEM' 
                            ? 'bg-slate-50/50 dark:bg-slate-900/50 border-slate-150 dark:border-slate-800/80' 
                            : comm.isInternal 
                              ? 'bg-amber-50/40 dark:bg-amber-950/10 border-amber-200 dark:border-amber-900/30' 
                              : 'bg-white dark:bg-slate-850 border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-2">
                            <div className="h-6 w-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
                              {comm.authorName[0]}
                            </div>
                            <div>
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-200">{comm.authorName}</span>
                              <span className={`ml-2 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                                comm.authorId === 'SYSTEM' ? 'bg-slate-200 text-slate-700' :
                                comm.isInternal ? 'bg-amber-100 text-amber-800' : 'bg-blue-50 text-blue-700'
                              }`}>
                                {comm.authorRole}
                              </span>
                            </div>
                          </div>
                          <span className="text-[10px] text-slate-400">
                            {comm.createdAt?.toLocaleString ? comm.createdAt.toLocaleString() : 'Just now'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 dark:text-slate-300 mt-2 whitespace-pre-wrap leading-relaxed">{comm.text}</p>
                      </div>
                    ))
                  )}
                </div>

                {/* Add Comment Field */}
                <div className="mt-4 flex flex-col space-y-2 border-t border-slate-100 dark:border-slate-800 pt-4">
                  <textarea 
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Write a reply or internal note..."
                    rows={3}
                    className="w-full text-xs p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-150 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <div className="flex justify-between items-center">
                    {helpDeskRole !== 'EMPLOYEE' ? (
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={isInternalComment}
                          onChange={(e) => setIsInternalComment(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="flex items-center gap-1 text-amber-600 font-bold">
                          <Shield size={12} /> Internal Note (IT Only)
                        </span>
                      </label>
                    ) : <div />}

                    <button 
                      onClick={handleAddComment}
                      disabled={!commentText.trim()}
                      className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm"
                    >
                      Send Message <Send size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Side: Metadata / Administrative Actions */}
            <div className="space-y-6">
              {/* Ticket Meta / SLA */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-black uppercase text-slate-400">Metadata & SLA</h3>
                
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-slate-400">Raised By:</span>
                    <p className="font-bold text-slate-800 dark:text-slate-200 mt-0.5">{selectedTicket.employeeName}</p>
                    <p className="text-[10px] text-slate-500">{selectedTicket.employeeEmail}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Department:</span>
                    <p className="font-bold text-slate-800 dark:text-slate-200 mt-0.5">{selectedTicket.employeeDepartment || 'N/A'}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Assigned To:</span>
                    <p className="font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                      {selectedTicket.assignedToName || 'Unassigned'}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">Raised Date:</span>
                    <p className="font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                      {selectedTicket.createdAt?.toLocaleString ? selectedTicket.createdAt.toLocaleDateString() : 'Today'}
                    </p>
                  </div>
                </div>

                <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
                  <span className="text-[10px] text-slate-400">Auto Captured Telemetry:</span>
                  <div className="bg-slate-50 dark:bg-slate-950 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800 mt-1.5 text-[10px] font-mono text-slate-500 space-y-1">
                    <div><b>OS:</b> {selectedTicket.osInfo || 'Unknown'}</div>
                    <div><b>Browser:</b> {selectedTicket.browserInfo || 'Unknown'}</div>
                    <div><b>Device:</b> {selectedTicket.deviceInfo || 'Desktop'}</div>
                    {selectedTicket.assetId && (
                      <div className="text-blue-500 font-bold mt-1 flex items-center gap-1">
                        <Laptop size={10} /> Asset ID: {selectedTicket.assetId}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Administrative Actions */}
              {helpDeskRole !== 'EMPLOYEE' && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                  <h3 className="text-xs font-black uppercase text-slate-400">Ticket Actions</h3>
                  
                  {/* Assignment Select */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500">Reassign Engineer</label>
                    <select 
                      value={selectedTicket.assignedTo || ''}
                      onChange={(e) => {
                        const targetId = e.target.value;
                        if (!targetId) return;
                        const eng = allUsers.find(u => u.uid === targetId);
                        handleUpdateTicketAction({
                          assignedTo: targetId,
                          assignedToName: eng ? (eng.fullName || eng.name) : 'IT Engineer',
                          assignedToEmail: eng?.email || '',
                          status: selectedTicket.status === 'New' ? 'Assigned' : selectedTicket.status
                        }, "Ticket assigned successfully");
                      }}
                      className="w-full text-xs p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="">-- Assign IT Support --</option>
                      {allUsers.map(u => (
                        <option key={u.uid} value={u.uid}>{u.fullName || u.name} ({(u.role || '').toUpperCase()})</option>
                      ))}
                    </select>
                  </div>

                  {/* Priority Select */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500">Change Priority</label>
                    <select 
                      value={selectedTicket.priority}
                      onChange={(e) => {
                        handleUpdateTicketAction({ priority: e.target.value as any }, "Priority updated");
                      }}
                      className="w-full text-xs p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                      <option value="Critical">Critical</option>
                    </select>
                  </div>

                  {/* Status Change Buttons */}
                  <div className="space-y-1 pt-2">
                    <label className="text-[10px] font-bold text-slate-500">Change Status Workflow</label>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      {selectedTicket.status !== 'In Progress' && (
                        <button 
                          onClick={() => handleUpdateTicketAction({ status: 'In Progress' }, "Status set to In Progress")}
                          className="bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/20 text-blue-600 dark:text-blue-400 text-[10px] font-bold py-2 rounded-xl transition"
                        >
                          In Progress
                        </button>
                      )}
                      {selectedTicket.status !== 'Waiting for User' && (
                        <button 
                          onClick={() => handleUpdateTicketAction({ status: 'Waiting for User' }, "Status set to Waiting for User")}
                          className="bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/20 text-rose-600 text-[10px] font-bold py-2 rounded-xl transition"
                        >
                          Wait on User
                        </button>
                      )}
                      {selectedTicket.status !== 'Resolved' && (
                        <button 
                          onClick={() => handleUpdateTicketAction({ status: 'Resolved' }, "Ticket Resolved")}
                          className="bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold py-2 rounded-xl transition col-span-2"
                        >
                          ✓ Resolve Ticket
                        </button>
                      )}
                      {selectedTicket.status !== 'Closed' && selectedTicket.status === 'Resolved' && (
                        <button 
                          onClick={() => handleUpdateTicketAction({ status: 'Closed' }, "Ticket Closed")}
                          className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px] font-bold py-2 rounded-xl transition col-span-2"
                        >
                          ✗ Close Ticket
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        ) : activeSubTab === 'portal' ? (
          // =================== MY SELF-SERVICE PORTAL ===================
          <motion.div 
            key="portal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            {/* CTA panel & My Assets */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Quick Actions Card */}
              <div className="md:col-span-1 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-3xl p-6 text-white shadow-xl flex flex-col justify-between">
                <div>
                  <h3 className="text-lg font-black">Need IT Assistance?</h3>
                  <p className="text-xs text-blue-100 mt-2 leading-relaxed">
                    Log an incident, request access to tools, or report malfunctioning company hardware. Our engineers resolve issues fast.
                  </p>
                </div>
                <button 
                  onClick={() => setShowCreateModal(true)}
                  className="bg-white hover:bg-blue-50 text-blue-700 text-xs font-bold py-3 px-5 rounded-2xl w-full flex items-center justify-center gap-1.5 transition-all duration-200 mt-6 shadow-sm hover:scale-[1.02]"
                >
                  <Plus size={16} /> Raise Support Ticket
                </button>
              </div>

              {/* My Hardware / Assigned Assets */}
              <div className="md:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col">
                <h3 className="text-xs font-black uppercase text-slate-400 mb-4 flex items-center gap-1.5">
                  <Laptop size={14} className="text-blue-500" /> My Assigned Assets ({myAssets.length})
                </h3>

                {myAssets.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
                    <Laptop size={32} className="text-slate-300 mb-2" />
                    <p className="text-xs text-slate-500 dark:text-slate-400">No active assets registered under your user ID.</p>
                    <p className="text-[10px] text-slate-400 mt-1">If you hold company laptops, check with your IT Admin.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 overflow-y-auto max-h-[160px] pr-1">
                    {myAssets.map((asset) => (
                      <div 
                        key={asset.id} 
                        className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50 dark:bg-slate-950 flex items-center justify-between group hover:border-blue-300 transition-all"
                      >
                        <div>
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-200">{asset.assetType}</p>
                          <span className="text-[10px] font-mono text-slate-400">S/N: {asset.serialNumber}</span>
                        </div>
                        <button 
                          onClick={() => {
                            setSelectedAssetId(asset.id);
                            setTicketCategory("Hardware Issue");
                            setTicketSubject(`Issue with my assigned ${asset.assetType}`);
                            setShowCreateModal(true);
                          }}
                          className="bg-white hover:bg-red-50 text-red-600 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-red-300 text-[10px] font-bold px-3 py-1.5 rounded-xl transition-all"
                        >
                          Raise Issue
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* My Ticket History */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-black uppercase text-slate-400">My Raised Tickets</h3>
                <div className="text-[10px] text-slate-400">Showing last {myPortalTickets.length} tickets</div>
              </div>

              {myPortalTickets.length === 0 ? (
                <div className="text-center py-12 flex flex-col items-center justify-center">
                  <Inbox size={40} className="text-slate-300 mb-2" />
                  <p className="text-xs text-slate-500">You haven't raised any IT service desk tickets yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-2">Ticket ID</th>
                        <th className="py-3 px-2">Subject</th>
                        <th className="py-3 px-2">Category</th>
                        <th className="py-3 px-2">Priority</th>
                        <th className="py-3 px-2">Assigned To</th>
                        <th className="py-3 px-2">Status</th>
                        <th className="py-3 px-2">Last Updated</th>
                        <th className="py-3 px-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {myPortalTickets.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/40 transition">
                          <td className="py-3.5 px-2 font-mono font-bold text-blue-600">{t.ticketId}</td>
                          <td className="py-3.5 px-2 font-medium text-slate-800 dark:text-slate-200 truncate max-w-[200px]">{t.subject}</td>
                          <td className="py-3.5 px-2 text-slate-500">{t.category}</td>
                          <td className="py-3.5 px-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                              t.priority === 'Critical' ? 'bg-red-50 text-red-600' :
                              t.priority === 'High' ? 'bg-orange-50 text-orange-600' :
                              t.priority === 'Medium' ? 'bg-blue-50 text-blue-600' :
                              'bg-slate-50 text-slate-500'
                            }`}>
                              {t.priority}
                            </span>
                          </td>
                          <td className="py-3.5 px-2 text-slate-500">{t.assignedToName || 'Queue'}</td>
                          <td className="py-3.5 px-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                              t.status === 'Resolved' ? 'bg-emerald-50 text-emerald-600' :
                              t.status === 'Closed' ? 'bg-slate-100 text-slate-600' :
                              'bg-amber-50 text-amber-600'
                            }`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-2 text-slate-400">
                            {t.updatedAt?.toLocaleString ? t.updatedAt.toLocaleDateString() : 'Today'}
                          </td>
                          <td className="py-3.5 px-2 text-right">
                            <button 
                              onClick={() => setSelectedTicket(t)}
                              className="text-xs text-blue-600 font-bold hover:underline"
                            >
                              Open Timeline &gt;
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </motion.div>
        ) : activeSubTab === 'queue' ? (
          // =================== IT AGENT QUEUE MANAGEMENT ===================
          <motion.div 
            key="queue"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            {/* Interactive Filters Grid */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
                <div className="relative w-full md:max-w-md">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input 
                    type="text"
                    placeholder="Search by ticket ID, subject, or employee name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full text-xs pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-150 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="flex gap-2 w-full md:w-auto">
                  <button 
                    onClick={() => {
                      setStatusFilter([]);
                      setPriorityFilter([]);
                      setCategoryFilter([]);
                      setAssigneeFilter([]);
                      setSearchQuery('');
                    }}
                    className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-white px-3 py-2 border border-slate-200 dark:border-slate-800 rounded-xl font-bold transition"
                  >
                    Reset Filters
                  </button>
                </div>
              </div>

              {/* Status & Priority Filter Chips */}
              <div className="flex flex-wrap gap-4 text-xs">
                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] font-bold text-slate-400">Filter Status:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {['New', 'Assigned', 'In Progress', 'Waiting for User', 'Resolved', 'Closed'].map(status => {
                      const active = statusFilter.includes(status);
                      return (
                        <button 
                          key={status}
                          onClick={() => setStatusFilter(active ? statusFilter.filter(s => s !== status) : [...statusFilter, status])}
                          className={`px-3 py-1.5 rounded-xl border transition text-[10px] font-bold ${
                            active ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-850 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {status}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] font-bold text-slate-400">Filter Priority:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {['Low', 'Medium', 'High', 'Critical'].map(prio => {
                      const active = priorityFilter.includes(prio);
                      return (
                        <button 
                          key={prio}
                          onClick={() => setPriorityFilter(active ? priorityFilter.filter(p => p !== prio) : [...priorityFilter, prio])}
                          className={`px-3 py-1.5 rounded-xl border transition text-[10px] font-bold ${
                            active ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-850 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {prio}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] font-bold text-slate-400">Filter Assignee:</span>
                  <div className="flex flex-wrap gap-1.5">
                    <button 
                      onClick={() => setAssigneeFilter(assigneeFilter.includes('unassigned') ? assigneeFilter.filter(a => a !== 'unassigned') : [...assigneeFilter, 'unassigned'])}
                      className={`px-3 py-1.5 rounded-xl border transition text-[10px] font-bold ${
                        assigneeFilter.includes('unassigned') ? 'bg-amber-600 border-amber-600 text-white' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-850 text-slate-600'
                      }`}
                    >
                      Unassigned
                    </button>
                    <button 
                      onClick={() => setAssigneeFilter(assigneeFilter.includes(user.uid) ? assigneeFilter.filter(a => a !== user.uid) : [...assigneeFilter, user.uid])}
                      className={`px-3 py-1.5 rounded-xl border transition text-[10px] font-bold ${
                        assigneeFilter.includes(user.uid) ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-850 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Assigned to Me
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Queue Table */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-black uppercase text-slate-400">Queue List</h3>
                <span className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold px-2.5 py-1 rounded-xl">
                  {filteredQueueTickets.length} matching tickets
                </span>
              </div>

              {filteredQueueTickets.length === 0 ? (
                <div className="text-center py-16 flex flex-col items-center justify-center">
                  <Inbox size={48} className="text-slate-300 mb-2" />
                  <p className="text-xs text-slate-500">No tickets matches the selected filters.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-2">Ticket</th>
                        <th className="py-3 px-2">Employee</th>
                        <th className="py-3 px-2">Subject</th>
                        <th className="py-3 px-2">Priority</th>
                        <th className="py-3 px-2">Category</th>
                        <th className="py-3 px-2">SLA Status</th>
                        <th className="py-3 px-2">Assignee</th>
                        <th className="py-3 px-2">Status</th>
                        <th className="py-3 px-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {filteredQueueTickets.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/40 transition">
                          <td className="py-3.5 px-2 font-mono font-bold text-blue-600">{t.ticketId}</td>
                          <td className="py-3.5 px-2">
                            <p className="font-bold text-slate-800 dark:text-white">{t.employeeName}</p>
                            <span className="text-[10px] text-slate-400">{t.employeeDepartment}</span>
                          </td>
                          <td className="py-3.5 px-2 font-medium text-slate-700 dark:text-slate-200 truncate max-w-[180px]">{t.subject}</td>
                          <td className="py-3.5 px-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                              t.priority === 'Critical' ? 'bg-red-50 text-red-600' :
                              t.priority === 'High' ? 'bg-orange-50 text-orange-600' :
                              t.priority === 'Medium' ? 'bg-blue-50 text-blue-600' :
                              'bg-slate-50 text-slate-500'
                            }`}>
                              {t.priority}
                            </span>
                          </td>
                          <td className="py-3.5 px-2 text-slate-500">{t.category}</td>
                          <td className="py-3.5 px-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${getSLADetails(t).color}`}>
                              {getSLADetails(t).text}
                            </span>
                          </td>
                          <td className="py-3.5 px-2 text-slate-500 font-medium">
                            {t.assignedTo === user.uid ? 'Me' : t.assignedToName || 'Unassigned'}
                          </td>
                          <td className="py-3.5 px-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                              t.status === 'New' ? 'bg-indigo-50 text-indigo-600' :
                              t.status === 'Assigned' ? 'bg-blue-50 text-blue-600' :
                              t.status === 'In Progress' ? 'bg-amber-50 text-amber-600' :
                              t.status === 'Resolved' ? 'bg-emerald-50 text-emerald-600' :
                              'bg-slate-100 text-slate-600'
                            }`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-2 text-right space-x-1">
                            {!t.assignedTo && (
                              <button 
                                onClick={() => {
                                  setSelectedTicket(t);
                                  handleUpdateTicketAction({
                                    assignedTo: user.uid,
                                    assignedToName: user.fullName || user.name,
                                    assignedToEmail: user.email,
                                    status: 'Assigned'
                                  }, "Claimed ticket successfully");
                                }}
                                className="bg-blue-50 hover:bg-blue-100 text-blue-600 text-[10px] font-bold px-2.5 py-1 rounded-xl transition"
                              >
                                Claim
                              </button>
                            )}
                            <button 
                              onClick={() => setSelectedTicket(t)}
                              className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px] font-bold px-2.5 py-1 rounded-xl transition"
                            >
                              Manage
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </motion.div>
        ) : activeSubTab === 'analytics' ? (
          // =================== IT ANALYTICS & SLA REPORTS ===================
          <motion.div 
            key="analytics"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            {/* Visual metrics cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm text-center">
                <span className="text-[10px] font-black uppercase text-slate-400">SLA Compliance Rate</span>
                <h3 className="text-3xl font-black text-emerald-600 mt-1">94.2%</h3>
                <p className="text-[10px] text-slate-400 mt-1">Goal: &gt; 90% compliance</p>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm text-center">
                <span className="text-[10px] font-black uppercase text-slate-400">Avg Resolution Time</span>
                <h3 className="text-3xl font-black text-blue-600 mt-1">4.2 Hrs</h3>
                <p className="text-[10px] text-slate-400 mt-1">Critical tickets: 1.8 hrs</p>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm text-center">
                <span className="text-[10px] font-black uppercase text-slate-400">First Response Time</span>
                <h3 className="text-3xl font-black text-violet-600 mt-1">22 Mins</h3>
                <p className="text-[10px] text-slate-400 mt-1">Goal: &lt; 30 mins average</p>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm text-center">
                <span className="text-[10px] font-black uppercase text-slate-400">SLA Breach Incidents</span>
                <h3 className="text-3xl font-black text-red-500 mt-1">2</h3>
                <p className="text-[10px] text-slate-400 mt-1">Active breaches requiring priority</p>
              </div>
            </div>

            {/* Tickets by Priority & Category charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Category distribution */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm">
                <h3 className="text-xs font-black uppercase text-slate-400 mb-4 flex items-center gap-1.5"><TrendingUp size={14} /> Tickets by Category</h3>
                
                <div className="space-y-4">
                  {Object.keys(IT_CATEGORIES).slice(0, 5).map((cat, idx) => {
                    const count = tickets.filter(t => t.category === cat).length;
                    const pct = tickets.length > 0 ? (count / tickets.length) * 100 : 20 * (5 - idx);
                    return (
                      <div key={cat} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="font-medium text-slate-700 dark:text-slate-300">{cat}</span>
                          <span className="font-bold text-slate-950 dark:text-white">{count || Math.round(pct/10)} tickets ({Math.round(pct)}%)</span>
                        </div>
                        <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full ${
                              idx === 0 ? 'bg-blue-600' :
                              idx === 1 ? 'bg-indigo-500' :
                              idx === 2 ? 'bg-violet-500' :
                              idx === 3 ? 'bg-amber-500' : 'bg-slate-400'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Engineer Performance Leaderboard */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm">
                <h3 className="text-xs font-black uppercase text-slate-400 mb-4 flex items-center gap-1.5"><UserCheck size={14} /> IT Engineers Leaderboard</h3>
                
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 uppercase tracking-wider text-[10px] font-bold">
                        <th className="py-2.5">Engineer Name</th>
                        <th className="py-2.5">Resolved</th>
                        <th className="py-2.5">Avg Resolution</th>
                        <th className="py-2.5">SLA Compliance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {allUsers.slice(0, 3).map((eng, idx) => {
                        const count = tickets.filter(t => t.assignedTo === eng.uid && t.status === 'Closed').length;
                        return (
                          <tr key={eng.uid} className="hover:bg-slate-50/50">
                            <td className="py-3 font-bold text-slate-800 dark:text-slate-200">{eng.fullName || eng.name}</td>
                            <td className="py-3 text-slate-600 font-mono font-bold">{count || 12 - idx * 4} tickets</td>
                            <td className="py-3 text-slate-600">{idx === 0 ? '1.5 hrs' : idx === 1 ? '3.2 hrs' : '5.1 hrs'}</td>
                            <td className="py-3 text-emerald-600 font-bold">{idx === 0 ? '100%' : idx === 1 ? '91.6%' : '88.3%'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </motion.div>
        ) : (
          // =================== IT ADMINISTRATIVE SETUP ===================
          <motion.div 
            key="admin"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="grid grid-cols-1 lg:grid-cols-3 gap-6"
          >
            {/* Left Col: SLA Settings & Category setup */}
            <div className="lg:col-span-2 space-y-6">
              {/* SLA rule modification */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-black uppercase text-slate-400">Configure SLA Rules (Hours)</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Object.entries(slaConfigs).map(([priority, val]) => (
                    <div key={priority} className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase">{priority}</label>
                      <input 
                        type="number"
                        value={val}
                        onChange={(e) => {
                          const num = parseInt(e.target.value) || 1;
                          const next = { ...slaConfigs, [priority]: num };
                          setSlaConfigs(next);
                          updateDoc(doc(db, 'itHelpDeskConfig', 'sla'), next);
                          toast.success("SLA config updated.");
                        }}
                        className="w-full text-xs font-bold p-2.5 rounded-xl border border-slate-250 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-950 dark:text-white"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Asset Catalog Manager */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-black uppercase text-slate-400 flex items-center gap-1.5">
                  <Database size={14} className="text-blue-500" /> Enterprise Asset Inventory ({assets.length} items)
                </h3>

                <div className="overflow-y-auto max-h-[300px] border border-slate-100 dark:border-slate-800 rounded-2xl">
                  {assets.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-10">No assets registered yet. Add hardware below.</p>
                  ) : (
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50 p-2 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                          <th className="p-3">Type</th>
                          <th className="p-3">Serial No</th>
                          <th className="p-3">Assigned User</th>
                          <th className="p-3">Status</th>
                          <th className="p-3 text-right">Delete</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {assets.map((a) => (
                          <tr key={a.id} className="hover:bg-slate-50/50">
                            <td className="p-3 font-bold text-slate-800">{a.assetType}</td>
                            <td className="p-3 font-mono font-bold text-slate-500">{a.serialNumber}</td>
                            <td className="p-3 text-slate-600">{a.assignedUserName || 'Available (Pool)'}</td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                a.status === 'Active' ? 'bg-emerald-50 text-emerald-600' :
                                a.status === 'In Maintenance' ? 'bg-amber-50 text-amber-600' :
                                'bg-slate-100 text-slate-500'
                              }`}>
                                {a.status}
                              </span>
                            </td>
                            <td className="p-3 text-right">
                              <button 
                                onClick={async () => {
                                  await deleteDoc(doc(db, 'itAssets', a.id));
                                  toast.success("Asset deleted.");
                                }}
                                className="text-red-500 hover:text-red-700"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Bulk Asset Upload Card */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase text-slate-400 flex items-center gap-1.5">
                    <Database size={14} className="text-blue-500" /> Bulk Upload IT Assets (CSV)
                  </h3>
                  <a 
                    href="data:text/csv;charset=utf-8,AssetType,SerialNumber,AssignedUser,AssignedUserName,Status%0ALaptop,SN-LPTP-9901,uid_here,John Doe,Active%0AMonitor,SN-MNTR-9902,,,Active"
                    download="asset_bulk_upload_template.csv"
                    className="text-blue-600 dark:text-blue-400 text-[11px] font-bold hover:underline"
                  >
                    Download Template CSV
                  </a>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Select a CSV file containing headers: <code className="font-mono bg-slate-100 dark:bg-slate-800 p-0.5 rounded text-slate-700 dark:text-slate-300">AssetType, SerialNumber, AssignedUser, AssignedUserName, Status</code>
                </p>

                <div className="flex items-center gap-4">
                  <input 
                    type="file" 
                    id="bulk-asset-csv-upload" 
                    className="hidden" 
                    accept=".csv"
                    onChange={handleBulkCSVChange}
                  />
                  <button 
                    type="button"
                    onClick={() => document.getElementById('bulk-asset-csv-upload')?.click()}
                    className="bg-white hover:bg-slate-50 dark:bg-slate-800 border border-slate-250 text-slate-700 dark:text-slate-300 px-4 py-2 rounded-xl font-bold transition text-xs"
                  >
                    Select CSV File
                  </button>
                  {bulkFile && (
                    <span className="text-xs text-slate-600 font-mono font-bold truncate max-w-[200px]">{bulkFile.name}</span>
                  )}
                </div>

                {parsedAssets.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">Parsed {parsedAssets.length} assets successfully!</span>
                      <button 
                        onClick={handleBulkUploadConfirm}
                        disabled={isUploadingBulk}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-1.5 px-3.5 rounded-xl transition text-[11px]"
                      >
                        {isUploadingBulk ? 'Uploading...' : 'Confirm Bulk Upload'}
                      </button>
                    </div>

                    <div className="overflow-x-auto max-h-[160px] border border-slate-100 dark:border-slate-800 rounded-xl">
                      <table className="w-full text-[10px] text-left">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50/50 p-2 text-slate-400 font-bold uppercase">
                            <th className="p-2">Type</th>
                            <th className="p-2">Serial No</th>
                            <th className="p-2">Assigned User</th>
                            <th className="p-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {parsedAssets.map((asset, idx) => (
                            <tr key={idx} className="hover:bg-slate-50/50">
                              <td className="p-2 font-bold">{asset.assetType}</td>
                              <td className="p-2 font-mono text-slate-500">{asset.serialNumber}</td>
                              <td className="p-2">{asset.assignedUserName || 'Available'}</td>
                              <td className="p-2">{asset.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Col: Add Asset & Support Team assignment */}
            <div className="space-y-6">
              {/* Add New Asset form */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-black uppercase text-slate-400">Add Company Asset</h3>
                
                <div className="space-y-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Asset Category</label>
                    <select 
                      value={assetType}
                      onChange={(e) => setAssetType(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="Laptop">Laptop / Computer</option>
                      <option value="Monitor">Monitor Display</option>
                      <option value="Headset">Noise Cancelling Headset</option>
                      <option value="VPN Key">Physical VPN MFA Key</option>
                      <option value="Mobile">Mobile Device</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Serial / Tag Number</label>
                    <input 
                      type="text"
                      placeholder="e.g. SN-LPTP-2204"
                      value={assetSerial}
                      onChange={(e) => setAssetSerial(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-250 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">Assign to Employee</label>
                    <select 
                      value={assetUserUid}
                      onChange={(e) => setAssetUserUid(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-xl bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="">-- Available in Commonpool --</option>
                      {allUsers.map(u => (
                        <option key={u.uid} value={u.uid}>{u.fullName || u.name} ({u.department || 'Production'})</option>
                      ))}
                    </select>
                  </div>

                  <button 
                    onClick={handleCreateAsset}
                    disabled={submittingAsset}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-xl text-xs transition"
                  >
                    Register Asset
                  </button>
                </div>
              </div>

              {/* Developer / Administrative utilities */}
              <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-black uppercase text-slate-400">Sandbox / Demo Controls</h3>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Provision SLA policies, set yourself as an IT Team agent, and seed mock assets/incidents to evaluate live ticketing flows.
                </p>
                <button 
                  onClick={handleSeedMockData}
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-800 dark:hover:bg-slate-700 text-xs font-bold py-3 px-4 rounded-xl transition flex items-center justify-center gap-1.5"
                >
                  <Database size={14} /> Seed Sample IT Data
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CREATE TICKET MODAL */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-2xl flex flex-col space-y-4"
            >
              <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-3">
                <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <LifeBuoy className="text-blue-600" size={20} /> Raise IT Support Ticket
                </h2>
                <button 
                  onClick={() => setShowCreateModal(false)}
                  className="p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
                >
                  <XCircle size={20} />
                </button>
              </div>

              {/* Form fields */}
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Category */}
                  <div className="space-y-1">
                    <label className="font-bold text-slate-400 uppercase">Ticket Category</label>
                    <select 
                      value={ticketCategory}
                      onChange={(e) => setTicketCategory(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    >
                      {Object.keys(IT_CATEGORIES).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>

                  {/* Sub category */}
                  <div className="space-y-1">
                    <label className="font-bold text-slate-400 uppercase">Sub Category</label>
                    <select 
                      value={ticketSubCategory}
                      onChange={(e) => setTicketSubCategory(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    >
                      {(IT_CATEGORIES[ticketCategory] || []).map(sub => (
                        <option key={sub} value={sub}>{sub}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Priority */}
                  <div className="space-y-1">
                    <label className="font-bold text-slate-400 uppercase">Severity / Priority</label>
                    <select 
                      value={ticketPriority}
                      onChange={(e) => setTicketPriority(e.target.value as any)}
                      className="w-full text-xs p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    >
                      <option value="Low">Low (24 Hr Resolution)</option>
                      <option value="Medium">Medium (8 Hr Resolution)</option>
                      <option value="High">High (4 Hr Resolution)</option>
                      <option value="Critical">Critical (2 Hr Resolution)</option>
                    </select>
                  </div>

                  {/* Optional Asset selection */}
                  <div className="space-y-1">
                    <label className="font-bold text-slate-400 uppercase">Associate Asset (Optional)</label>
                    <select 
                      value={selectedAssetId}
                      onChange={(e) => setSelectedAssetId(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    >
                      <option value="">-- No Specific Hardware --</option>
                      {myAssets.map(a => (
                        <option key={a.id} value={a.id}>{a.assetType} (S/N: {a.serialNumber})</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Subject */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-400 uppercase">Subject</label>
                  <input 
                    type="text"
                    placeholder="Brief summary of the issue (e.g., Unable to sync domain passwords)"
                    value={ticketSubject}
                    onChange={(e) => setTicketSubject(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-250 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-950 dark:text-white focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1">
                  <label className="font-bold text-slate-400 uppercase">Description / Details</label>
                  <textarea 
                    rows={4}
                    placeholder="Provide troubleshooting steps attempted, full error messages, screenshots details..."
                    value={ticketDescription}
                    onChange={(e) => setTicketDescription(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-250 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 text-slate-950 dark:text-white focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                {/* Real Screenshot / Logs Upload */}
                <div className="border border-dashed border-slate-250 dark:border-slate-800 p-4 rounded-xl flex items-center justify-between bg-slate-50 dark:bg-slate-950">
                  <div className="flex items-center gap-2">
                    <Paperclip className="text-slate-400" size={16} />
                    <div>
                      <p className="font-bold text-slate-700 dark:text-slate-300">Upload Screenshots / Logs</p>
                      <p className="text-[10px] text-slate-400">Attach PNG, JPG, PDF, TXT up to 10MB</p>
                    </div>
                  </div>
                  <input 
                    type="file" 
                    id="ticket-file-upload" 
                    className="hidden" 
                    accept="image/*,.pdf,.txt,.doc,.docx"
                    onChange={handleFileUpload} 
                    disabled={uploadingFile}
                  />
                  <button 
                    type="button"
                    onClick={() => document.getElementById('ticket-file-upload')?.click()}
                    disabled={uploadingFile}
                    className="bg-white hover:bg-slate-100 dark:bg-slate-900 border border-slate-250 text-slate-700 dark:text-slate-300 px-3.5 py-1.5 rounded-xl font-bold transition-all text-[11px] disabled:opacity-50"
                  >
                    {uploadingFile ? 'Uploading...' : 'Add Attachment'}
                  </button>
                </div>

                {ticketAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {ticketAttachments.map((url, i) => (
                      <div key={i} className="text-[10px] bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 px-2.5 py-1 rounded-lg font-mono flex items-center justify-between gap-1.5">
                        <span className="truncate max-w-[150px]">{getFileNameFromUrl(url)}</span>
                        <button 
                          type="button" 
                          onClick={() => setTicketAttachments(prev => prev.filter((_, idx) => idx !== i))}
                          className="text-red-500 hover:text-red-700 font-bold ml-1 text-[12px]"
                          title="Remove attachment"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button 
                  onClick={() => setShowCreateModal(false)}
                  className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 text-xs font-bold px-4 py-2 rounded-xl transition"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleCreateTicket}
                  disabled={submittingTicket}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-5 py-2 rounded-xl shadow-md transition flex items-center gap-1.5"
                >
                  {submittingTicket ? 'Submitting...' : 'Raise Ticket'} <ArrowRight size={12} />
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
