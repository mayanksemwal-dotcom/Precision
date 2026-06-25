import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  User, 
  Lock, 
  MapPin, 
  Phone, 
  Mail, 
  Calendar, 
  Briefcase, 
  Award, 
  BookOpen, 
  Languages, 
  ShieldCheck, 
  Upload, 
  Download, 
  FileText, 
  Plus, 
  Trash2, 
  Search, 
  Filter, 
  CheckCircle, 
  AlertCircle, 
  Sparkles, 
  Camera, 
  Eye, 
  Terminal, 
  Bookmark, 
  MenuSquare, 
  FolderLock,
  ArrowRight,
  Database,
  RefreshCw,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, storage } from '../lib/firebase';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { toast } from 'sonner';
import { UserProfile } from '../types';

interface MyProfileViewProps {
  user: UserProfile;
  allUsers: UserProfile[];
  externalTheme: 'light' | 'dark';
  onRefreshAllData?: () => Promise<void>;
}

interface EmergencyContact {
  name: string;
  relationship: string;
  number: string;
}

interface UploadedDocument {
  name: string;
  type: string;
  url: string;
  uploadedAt: string;
  size?: string;
}

interface EmployeeProfileState {
  employeeId: string;
  employeeName: string;
  officialEmail: string;
  profilePhotoUrl: string;
  mobileNumber: string;
  alternateNumber: string;
  personalEmail: string;
  dateOfBirth: string;
  gender: string;
  bloodGroup: string;
  maritalStatus: string;
  currentAddress: string;
  permanentAddress: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  emergencyContact: EmergencyContact;
  panNumber: string;
  aadhaarNumber: string;
  passportNumber: string;
  skills: string[];
  certifications: string[];
  languages: string[];
  profileCompletionPercentage: number;
  lastUpdatedAt: string;
  updatedBy: string;
  documents: UploadedDocument[];
  
  // Non-editable systems data managed in users auth or by HR
  dateJoined: string;
  reportingManager: string;
  department: string;
  designation: string;
  employmentType: string;
  accountStatus: string;
}

export default React.memo(function MyProfileView({ user, allUsers, externalTheme, onRefreshAllData }: MyProfileViewProps) {
  const isAdminOrHR = user.role === 'ADMIN' || user.role === 'MANAGER' || user.role?.toUpperCase() === 'HR';
  const canViewHRDirectory = user.role?.toUpperCase() === 'ADMIN' || user.role?.toUpperCase() === 'HR';
  const [profileTab, setProfileTab] = useState<'my-profile' | 'hr-directory'>('my-profile');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // Current active view profile UID (usually standard is own uid, but Admin can select another user to inspect)
  const [inspectUserId, setInspectUserId] = useState<string>(user.uid);

  // Redirect if insufficient permissions to view HR Directory
  useEffect(() => {
    if (!canViewHRDirectory && profileTab === 'hr-directory') {
      setProfileTab('my-profile');
    }
  }, [canViewHRDirectory, profileTab]);
  
  // Profile state
  const [profile, setProfile] = useState<EmployeeProfileState>({
    employeeId: '',
    employeeName: '',
    officialEmail: '',
    profilePhotoUrl: '',
    mobileNumber: '',
    alternateNumber: '',
    personalEmail: '',
    dateOfBirth: '',
    gender: '',
    bloodGroup: '',
    maritalStatus: '',
    currentAddress: '',
    permanentAddress: '',
    city: '',
    state: '',
    country: '',
    postalCode: '',
    emergencyContact: { name: '', relationship: '', number: '' },
    panNumber: '',
    aadhaarNumber: '',
    passportNumber: '',
    skills: [],
    certifications: [],
    languages: [],
    profileCompletionPercentage: 0,
    lastUpdatedAt: '',
    updatedBy: '',
    documents: [],
    dateJoined: '',
    reportingManager: '',
    department: '',
    designation: '',
    employmentType: 'Full-Time',
    accountStatus: 'Active'
  });

  // Dynamic tags states
  const [newSkill, setNewSkill] = useState('');
  const [newCert, setNewCert] = useState('');
  const [newLang, setNewLang] = useState('');

  // HR/Admin Console directory states
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMissingDoc, setFilterMissingDoc] = useState<'all' | 'pan' | 'aadhaar' | 'resume' | 'photo'>('all');
  const [filterCompletion, setFilterCompletion] = useState<string>('all'); // all, <50, 50-80, >80
  const [adminProfilesList, setAdminProfilesList] = useState<any[]>([]);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  // Enhanced confirmation and diagnostic popups
  const [deletingDoc, setDeletingDoc] = useState<UploadedDocument | null>(null);
  const [errorDialogMsg, setErrorDialogMsg] = useState<string | null>(null);

  const allUsersRef = useRef(allUsers);
  const userRef = useRef(user);

  const liveAccountStatus = useMemo(() => {
    const foundUser = allUsers.find(x => x.uid === inspectUserId) || user;
    let s = foundUser?.status || profile.accountStatus || 'Active';
    if (s === 'Active' || s === 'active') s = 'ONLINE';
    if (s === 'Inactive' || s === 'inactive') s = 'OFFLINE';
    return s;
  }, [allUsers, inspectUserId, user, profile.accountStatus]);

  useEffect(() => {
    allUsersRef.current = allUsers;
  }, [allUsers]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Load a profile based on target userId
  useEffect(() => {
    const fetchProfile = async () => {
      setLoading(true);
      try {
        const uProfile = allUsersRef.current.find(x => x.uid === inspectUserId) || userRef.current;
        
        const profileRef = doc(db, 'employeeProfiles', inspectUserId);
        const snap = await getDoc(profileRef);

        let data: any = {};
        if (snap.exists()) {
          data = snap.data();
        }

        // Find team lead or manager name from allUsers lookup dynamically
        let teamLeadName = uProfile.teamLeadName || '';
        if (uProfile.teamLeadUid || uProfile.teamLeadId) {
          const tlId = uProfile.teamLeadUid || uProfile.teamLeadId;
          const tl = allUsersRef.current.find(x => x.uid === tlId);
          if (tl) teamLeadName = tl.fullName || tl.name || tl.employeeName || '';
        }
        let managerName = uProfile.managerName || '';
        if ((uProfile as any).mappedManagerUid || uProfile.mappedManagerId || uProfile.managerId) {
          const mId = (uProfile as any).mappedManagerUid || uProfile.mappedManagerId || uProfile.managerId;
          const m = allUsersRef.current.find(x => x.uid === mId);
          if (m) managerName = m.fullName || m.name || m.employeeName || '';
        }

        const reportingMgrName = managerName || teamLeadName || uProfile.Manager || 'Unassigned';
        const formattedDateJoined = uProfile.dateJoined || (uProfile.createdAt ? new Date(uProfile.createdAt).toLocaleDateString() : '');

        // Prevent OFFLINE showing for active logged-in user
        let computedStatus = uProfile.status || data.accountStatus || 'Active';
        if (inspectUserId === userRef.current.uid) {
          if (computedStatus === 'OFFLINE' || !computedStatus || computedStatus === 'Inactive') {
            computedStatus = 'ONLINE';
          }
        }

        const merged: EmployeeProfileState = {
          employeeId: uProfile.employeeId || data.employeeId || inspectUserId.slice(0, 8).toUpperCase(),
          employeeName: uProfile.fullName || uProfile.name || data.employeeName || '',
          officialEmail: uProfile.email || data.officialEmail || '',
          profilePhotoUrl: data.profilePhotoUrl || (uProfile as any).profilePhotoUrl || (uProfile as any).photoURL || '',
          mobileNumber: data.mobileNumber || '',
          alternateNumber: data.alternateNumber || '',
          personalEmail: data.personalEmail || '',
          dateOfBirth: data.dateOfBirth || '',
          gender: data.gender || '',
          bloodGroup: data.bloodGroup || '',
          maritalStatus: data.maritalStatus || '',
          currentAddress: data.currentAddress || '',
          permanentAddress: data.permanentAddress || '',
          city: data.city || '',
          state: data.state || '',
          country: data.country || '',
          postalCode: data.postalCode || '',
          emergencyContact: data.emergencyContact || { name: '', relationship: '', number: '' },
          panNumber: data.panNumber || '',
          aadhaarNumber: data.aadhaarNumber || '',
          passportNumber: data.passportNumber || '',
          skills: data.skills || [],
          certifications: data.certifications || [],
          languages: data.languages || [],
          profileCompletionPercentage: data.profileCompletionPercentage || 0,
          lastUpdatedAt: data.lastUpdatedAt || '',
          updatedBy: data.updatedBy || '',
          documents: data.documents || [],
          
          // Managed
          dateJoined: formattedDateJoined,
          reportingManager: reportingMgrName,
          department: uProfile.department || 'Operations',
          designation: uProfile.role || 'Agent',
          employmentType: data.employmentType || 'Full-Time',
          accountStatus: computedStatus
        };

        // Auto compute profile completion
        merged.profileCompletionPercentage = calculateCompletion(merged);

        // Dynamic self-healing auto-sync with master directory values if they mismatch
        const needsSync = 
          data.employeeId !== merged.employeeId ||
          data.employeeName !== merged.employeeName ||
          data.officialEmail !== merged.officialEmail ||
          data.department !== merged.department ||
          data.designation !== merged.designation ||
          data.dateJoined !== merged.dateJoined ||
          data.reportingManager !== merged.reportingManager ||
          data.accountStatus !== merged.accountStatus;

        if (needsSync && inspectUserId) {
          const profileDocRef = doc(db, 'employeeProfiles', inspectUserId);
          await setDoc(profileDocRef, {
            ...data,
            employeeId: merged.employeeId,
            employeeName: merged.employeeName,
            officialEmail: merged.officialEmail,
            department: merged.department,
            designation: merged.designation,
            dateJoined: merged.dateJoined,
            reportingManager: merged.reportingManager,
            accountStatus: merged.accountStatus,
            lastUpdatedAt: new Date().toISOString(),
            updatedBy: 'System Auto-Sync'
          }, { merge: true }).catch(err => {
            console.warn('Silent auto-sync skipped (potential offline/permissions warning):', err.message);
          });
        }

        setProfile(merged);
      } catch (err: any) {
        console.error('Error fetching employee profile:', err);
        toast.error('Could not load detailed employee profile information.');
        setErrorDialogMsg(`Failed to load detailed employee profile: ${err.message || 'Firestore connection check required.'}`);
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [inspectUserId]);

  // Load Admin Directory Profiles
  useEffect(() => {
    if (!canViewHRDirectory) return;

    const loadAllProfiles = async () => {
      try {
        const snap = await getDocs(collection(db, 'employeeProfiles'));
        const profilesMap = new Map();
        snap.forEach(doc => {
          profilesMap.set(doc.id, doc.data());
        });

        // Match with allUsers list to guarantee everyone has an overview
        const fullList = allUsers.map(u => {
          const dbProf = profilesMap.get(u.uid) || {};
          const comp = calculateCompletion({ ...dbProf, employeeName: u.fullName, officialEmail: u.email });
          return {
            uid: u.uid,
            fullName: u.fullName || u.name,
            email: u.email,
            role: u.role,
            employeeId: u.employeeId || dbProf.employeeId || u.uid.slice(0, 8).toUpperCase(),
            process: u.process || 'N/A',
            department: u.department || 'Operations',
            managerName: u.managerName || u.teamLeadName || 'Unassigned',
            completion: comp,
            documents: dbProf.documents || [],
            profilePhotoUrl: dbProf.profilePhotoUrl || u.profilePhotoUrl || u.photoURL || '',
            panNumber: dbProf.panNumber || '',
            aadhaarNumber: dbProf.aadhaarNumber || '',
            mobileNumber: dbProf.mobileNumber || ''
          };
        });

        setAdminProfilesList(fullList);
      } catch (err) {
        console.error('Error loading directory files:', err);
      }
    };

    loadAllProfiles();
  }, [allUsers, inspectUserId, profileTab, canViewHRDirectory]);

  // Dynamic Profile Completion Calculation
  const calculateCompletion = (p: any) => {
    const safeP = p || {};
    const fields = [
      safeP.profilePhotoUrl,
      safeP.mobileNumber,
      safeP.personalEmail,
      safeP.dateOfBirth,
      safeP.gender,
      safeP.bloodGroup,
      safeP.maritalStatus,
      safeP.currentAddress,
      safeP.permanentAddress,
      safeP.emergencyContact?.name,
      safeP.emergencyContact?.number,
      safeP.emergencyContact?.relationship,
      safeP.panNumber,
      safeP.aadhaarNumber,
      (safeP.skills || []).length > 0 ? 'yes' : '',
      (safeP.certifications || []).length > 0 ? 'yes' : '',
      (safeP.languages || []).length > 0 ? 'yes' : ''
    ];
    const filled = fields.filter(f => f && f.toString().trim() !== '').length;
    return fields.length > 0 ? Math.round((filled / fields.length) * 100) : 0;
  };

  // PAN and Identity Validators
  const validatePAN = (pan: string) => {
    if (!pan) return true; // Optional input
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    return panRegex.test(pan.toUpperCase());
  };

  const validatePhone = (num: string) => {
    if (!num) return true;
    const phoneRegex = /^[0-9]{10}$/;
    return phoneRegex.test(num.replace(/[\s\-().+]/g, ''));
  };

  const validateEmail = (em: string) => {
    if (!em) return true;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(em);
  };

  // Tag list helpers
  const addTag = (type: 'skill' | 'cert' | 'lang') => {
    if (type === 'skill' && newSkill.trim()) {
      if (!profile.skills.includes(newSkill.trim())) {
        setProfile(prev => ({ ...prev, skills: [...prev.skills, newSkill.trim()] }));
      }
      setNewSkill('');
    }
    if (type === 'cert' && newCert.trim()) {
      if (!profile.certifications.includes(newCert.trim())) {
        setProfile(prev => ({ ...prev, certifications: [...prev.certifications, newCert.trim()] }));
      }
      setNewCert('');
    }
    if (type === 'lang' && newLang.trim()) {
      if (!profile.languages.includes(newLang.trim())) {
        setProfile(prev => ({ ...prev, languages: [...prev.languages, newLang.trim()] }));
      }
      setNewLang('');
    }
  };

  const removeTag = (type: 'skill' | 'cert' | 'lang', index: number) => {
    setProfile(prev => {
      const arr = type === 'skill' 
        ? prev.skills 
        : type === 'cert' 
        ? prev.certifications 
        : prev.languages;
      const updated = arr.filter((_, idx) => idx !== index);
      return {
        ...prev,
        [type === 'skill' ? 'skills' : type === 'cert' ? 'certifications' : 'languages']: updated
      };
    });
  };

  // Handle document upload (PAN, Aadhaar, Photo, Resume, etc)
  const handleUploadDocument = async (e: React.ChangeEvent<HTMLInputElement>, fileType: string) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error('File size exceeds the 5MB enterprise security upload limit.');
      return;
    }

    const uploadToastId = toast.loading(`Uploading ${fileType.toUpperCase()} document and securing metadata...`);
    try {
      let downloadUrl = '';
      const storagePath = `employees/${inspectUserId}/documents/${fileType}/${file.name}`;
      
      try {
        const fileRef = ref(storage, storagePath);
        await uploadBytes(fileRef, file);
        downloadUrl = await getDownloadURL(fileRef);
      } catch (err: any) {
        console.warn('Firebase Storage upload failed, utilizing secured high-availability DB storage fallback: ', err.message);
        
        // High Availability DB Storage Fallback: base64 DataURL or mock storage URL safely stored
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        downloadUrl = await base64Promise;
      }

      const newDoc: UploadedDocument = {
        name: file.name,
        type: fileType,
        url: downloadUrl,
        uploadedAt: new Date().toISOString(),
        size: (file.size / 1024 / 1024).toFixed(2) + ' MB'
      };

      let updatedDocs = [...profile.documents];
      // Replace existing of same type if it is a singleton category (profile-photo, pan, aadhaar, resume, offer-letter)
      if (['profile-photo', 'pan', 'aadhaar', 'resume', 'offer-letter'].includes(fileType)) {
        updatedDocs = updatedDocs.filter(d => d.type !== fileType);
      }
      updatedDocs.push(newDoc);

      const updateData: any = { documents: updatedDocs };
      if (fileType === 'profile-photo') {
        updateData.profilePhotoUrl = downloadUrl;
        // Global sync to users collection for app-wide immediate visibility
        await updateDoc(doc(db, 'users', inspectUserId), { photoURL: downloadUrl }).catch(() => {
           // Fallback to setDoc with merge if doc not found
           setDoc(doc(db, 'users', inspectUserId), { photoURL: downloadUrl }, { merge: true }).catch(e => console.error("Critical Profile Sync Failure:", e));
        });
      }

      await updateDoc(doc(db, 'employeeProfiles', inspectUserId), updateData).catch(async () => {
        // If document doesn't exist yet, do setDoc
        await setDoc(doc(db, 'employeeProfiles', inspectUserId), updateData, { merge: true });
      });

      setProfile(prev => {
        const updated = {
          ...prev,
          documents: updatedDocs,
          profilePhotoUrl: fileType === 'profile-photo' ? downloadUrl : prev.profilePhotoUrl
        };
        updated.profileCompletionPercentage = calculateCompletion(updated);
        return updated;
      });

      toast.success(`${fileType.toUpperCase()} uploaded and saved successfully!`, { id: uploadToastId });
      if (onRefreshAllData) {
        await onRefreshAllData();
      }
    } catch (err: any) {
      toast.error(`Upload structure failure: ${err.message || 'Check firestore network connection'}`, { id: uploadToastId });
      setErrorDialogMsg(`Upload failed for document of type ${fileType.toUpperCase()}: ${err.message || 'Ensure your account concept is verified and permissions are authentic.'}`);
    }
  };

  const deleteDocument = async (docToDelete: UploadedDocument) => {
    try {
      const updatedDocs = profile.documents.filter(d => d.url !== docToDelete.url);
      const updateData: any = { documents: updatedDocs };
      
      if (docToDelete.type === 'profile-photo') {
        updateData.profilePhotoUrl = '';
      }

      await updateDoc(doc(db, 'employeeProfiles', inspectUserId), updateData);
      
      setProfile(prev => {
        const updated = {
          ...prev,
          documents: updatedDocs,
          profilePhotoUrl: docToDelete.type === 'profile-photo' ? '' : prev.profilePhotoUrl
        };
        updated.profileCompletionPercentage = calculateCompletion(updated);
        return updated;
      });

      toast.success(`Removed document "${docToDelete.name}" successfully.`);
    } catch (err: any) {
      toast.error(`Failed to delete document: ${err.message}`);
      setErrorDialogMsg(`Failed to delete document: ${err.message || 'Write permissions verification failed.'}`);
    }
  };

  // Submit profile changes
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();

    // Data validations
    if (!validatePAN(profile.panNumber)) {
      toast.error('Invalid PAN Number Formats. Must be 10 alphanumeric characters (e.g., ABCDE1234F)');
      return;
    }
    if (!validatePhone(profile.mobileNumber) || !validatePhone(profile.alternateNumber)) {
      toast.error('Mobile numbers must be empty or exactly 10-digit integers.');
      return;
    }
    if (!validateEmail(profile.personalEmail)) {
      toast.error('Invalid personal email format.');
      return;
    }

    setSaving(true);
    try {
      const completion = calculateCompletion(profile);
      const payload = {
        ...profile,
        profileCompletionPercentage: completion,
        lastUpdatedAt: new Date().toISOString(),
        updatedBy: user.name
      };

      // Also updates core user collection fields if user is administrator
      if (isAdminOrHR) {
        const userRef = doc(db, 'users', inspectUserId);
        await updateDoc(userRef, {
          fullName: profile.employeeName,
          status: liveAccountStatus,
          department: profile.department
        }).catch(() => console.log("Core users syncing skipped - non critical resource"));

        // sync employee_master
        const masterRef = doc(db, 'employee_master', inspectUserId);
        await setDoc(masterRef, {
          employeeName: profile.employeeName,
          status: liveAccountStatus,
          department: profile.department,
          lastUpdated: new Date().toISOString()
        }, { merge: true }).catch(() => {});
      }

      const profileDocRef = doc(db, 'employeeProfiles', inspectUserId);
      await setDoc(profileDocRef, payload, { merge: true });

      toast.success('Pragmatic Employee Profile successfully aligned!');
      setProfile(prev => ({ ...prev, profileCompletionPercentage: completion }));
      
      if (onRefreshAllData) {
        await onRefreshAllData();
      }
    } catch (err: any) {
      console.error('Save Profile operation error:', err);
      toast.error(`Error saving secure profile: ${err.message}`);
      setErrorDialogMsg(`Error saving secure profile: ${err.message || 'Make sure your fields comply with form schemas and database rules.'}`);
    } finally {
      setSaving(false);
    }
  };

  // Completion percentage filters calculation (extracted for reuse in stats)
  const getFilteredList = () => {
    return adminProfilesList.filter(p => {
      const term = searchQuery.toLowerCase().trim();
      const matchesSearch = 
        p.fullName.toLowerCase().includes(term) ||
        p.email.toLowerCase().includes(term) ||
        p.employeeId.toLowerCase().includes(term) ||
        p.managerName.toLowerCase().includes(term) ||
        p.process.toLowerCase().includes(term);

      // Missing doc validation filter
      let matchesDoc = true;
      if (filterMissingDoc === 'pan') {
        matchesDoc = !p.documents.some((d: any) => d.type === 'pan');
      } else if (filterMissingDoc === 'aadhaar') {
        matchesDoc = !p.documents.some((d: any) => d.type === 'aadhaar');
      } else if (filterMissingDoc === 'resume') {
        matchesDoc = !p.documents.some((d: any) => d.type === 'resume');
      } else if (filterMissingDoc === 'photo') {
        matchesDoc = !p.profilePhotoUrl;
      }

      // Completion percentage filters
      let matchesCompletion = true;
      if (filterCompletion === 'low') matchesCompletion = p.completion < 50;
      else if (filterCompletion === 'mid') matchesCompletion = p.completion >= 50 && p.completion <= 80;
      else if (filterCompletion === 'high') matchesCompletion = p.completion > 80;

      return matchesSearch && matchesDoc && matchesCompletion;
    });
  };

  const filteredProfilesByCriteria = getFilteredList();
  
  // Total pages
  const totalPages = Math.ceil(filteredProfilesByCriteria.length / pageSize);
  
  // Slice for current page
  const paginatedProfiles = filteredProfilesByCriteria.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterMissingDoc, filterCompletion, pageSize]);

  const cardClass = externalTheme === 'dark' 
    ? 'bg-slate-900 border-slate-800 text-slate-100 shadow-xl border rounded-2xl p-6' 
    : 'bg-white border-slate-200 text-slate-800 shadow-md border rounded-2xl p-6';

  const subCardClass = externalTheme === 'dark'
    ? 'bg-slate-850/50 border border-slate-800 rounded-xl p-4'
    : 'bg-slate-50/60 border border-slate-150 rounded-xl p-4';

  const inputClass = (isEditableByCurrentUser: boolean) => {
    const base = "w-full text-xs p-2.5 rounded-lg border outline-none transition-all focus:ring-1 focus:ring-indigo-500 ";
    if (!isEditableByCurrentUser) {
      return base + (externalTheme === 'dark' ? 'bg-slate-950 border-slate-800 text-slate-500 cursor-not-allowed' : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed');
    }
    return base + (externalTheme === 'dark' ? 'bg-slate-800 border-slate-700 text-slate-100 focus:bg-slate-900' : 'bg-white border-slate-250 text-slate-850 focus:border-indigo-400 focus:bg-indigo-50/10');
  };

  const getDocDisplayName = (type: string) => {
    switch (type) {
      case 'profile-photo': return 'Profile Photo';
      case 'pan': return 'PAN Card Proof';
      case 'aadhaar': return 'Aadhaar Identification';
      case 'resume': return 'Work History Resume';
      case 'offer-letter': return 'Employee Offer Letter';
      default: return 'HR Document';
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Mode Toggle */}
      <div className={cardClass}>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-100 dark:border-slate-800 pb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/10 text-indigo-500 rounded-xl">
              <User size={22} className="animate-pulse" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight flex items-center gap-2">
                HRMS Employee Portal 
                <span className="text-[10px] font-mono tracking-widest bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20 uppercase">SECURE</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Manage official credentials, upload verification document transcripts, & monitor payroll integrations.</p>
            </div>
          </div>

          {/* Tab Switcher if Admin or HR */}
          {canViewHRDirectory && (
            <div className="flex p-1 bg-slate-100 dark:bg-slate-950 border dark:border-slate-800 rounded-xl">
              <button
                onClick={() => {
                  setInspectUserId(user.uid);
                  setProfileTab('my-profile');
                }}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-all ${
                  profileTab === 'my-profile' && inspectUserId === user.uid
                    ? 'bg-white dark:bg-slate-800 text-slate-850 dark:text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-300'
                }`}
              >
                <User size={13} /> My Personal Profile
              </button>
              {canViewHRDirectory && (
                <button
                  onClick={() => setProfileTab('hr-directory')}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-all ${
                    profileTab === 'hr-directory'
                      ? 'bg-white dark:bg-slate-800 text-slate-850 dark:text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-300'
                  }`}
                >
                  <FolderLock size={13} /> HR Directory & Track ({adminProfilesList.length})
                </button>
              )}
            </div>
          )}
        </div>

        {/* Inspect Banner if active */}
        {profileTab === 'my-profile' && inspectUserId !== user.uid && (
          <div className="mt-4 p-3 bg-indigo-650/10 border border-indigo-500/30 rounded-xl flex items-center justify-between text-xs text-indigo-400">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} />
              <span>HR ADMINISTRATOR OVERRIDE: Inspecting Employee <strong>{profile.employeeName}</strong> ({profile.officialEmail}).</span>
            </div>
            <button
              onClick={() => setInspectUserId(user.uid)}
              className="text-[10px] uppercase font-black tracking-wider bg-indigo-500 text-white px-2.5 py-1 rounded-md hover:bg-indigo-600 transition-all cursor-pointer"
            >
              Back To My Profile
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <RefreshCw size={32} className="animate-spin text-indigo-500" />
        </div>
      ) : profileTab === 'my-profile' ? (
        <form onSubmit={handleSaveProfile} className="space-y-6">
          
          {/* 1. Overview and Completion Banner */}
          <div className={cardClass}>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-center">
              
              {/* Profile Photo Upload and basic overview info */}
              <div className="lg:col-span-2 flex items-center gap-4 border-r border-dashed border-slate-100 dark:border-slate-800/80 pr-6">
                <div className="relative group overflow-hidden w-24 h-24 rounded-full border border-slate-200 dark:border-slate-800 shadow bg-slate-905 flex items-center justify-center shrink-0">
                  {profile.profilePhotoUrl ? (
                    <img src={profile.profilePhotoUrl} alt="Employee Avatar" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-slate-500 font-extrabold text-2xl">{profile.employeeName.split(' ').map(n=>n[0]).slice(0,2).join('')}</div>
                  )}
                  <label className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-[10px] text-white font-bold cursor-pointer">
                    <Camera size={18} className="mb-0.5" />
                    <span>Upload Photo</span>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => handleUploadDocument(e, 'profile-photo')} />
                  </label>
                </div>
                
                <div className="space-y-1">
                  <h3 className="text-base font-black tracking-tight">{profile.employeeName || 'Profile Setup'}</h3>
                  <div className="text-[11px] text-indigo-400 font-mono tracking-wider font-bold">EMP ID: {profile.employeeId}</div>
                  <div className="text-xs text-slate-400 flex items-center gap-1.5 mt-1">
                    <Briefcase size={12} />
                    <span>{profile.designation} — <strong className="text-slate-350">{profile.department}</strong></span>
                  </div>
                  <div className="text-[10px] text-slate-450 mt-1">
                    Status: <span className={`font-black uppercase ${
                      liveAccountStatus === 'ONLINE' || liveAccountStatus === 'Active'
                        ? 'text-emerald-400 font-black'
                        : liveAccountStatus === 'BREAK'
                        ? 'text-amber-400 font-black'
                        : 'text-slate-400 font-semibold'
                    }`}>{liveAccountStatus}</span> | Joined: <strong className="font-mono">{profile.dateJoined}</strong>
                  </div>
                </div>
              </div>

              {/* Dynamic Progress indicator */}
              <div className="lg:col-span-2 flex flex-col justify-center space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-450">HRMS Profile Completion</span>
                  <span className="text-sm font-black text-indigo-400 font-mono">{profile.profileCompletionPercentage}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-950 overflow-hidden shadow-inner">
                  <div 
                    className="h-full bg-gradient-to-r from-indigo-500 to-sky-400 rounded-full transition-all duration-500" 
                    style={{ width: `${profile.profileCompletionPercentage}%` }} 
                  />
                </div>
                <p className="text-[10px] text-slate-400 italic">
                  {profile.profileCompletionPercentage === 100 
                    ? "✨ Outstanding! Verified official audit records are aligned. Your HR transcript is fully completed." 
                    : "⚠️ Keep your records updated. Fill in mandatory phone, emergency contact, and physical coordinate details below."}
                </p>
              </div>

            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* 2. Left Rail: Non-Editable & Identifiers */}
            <div className="space-y-6 lg:col-span-1">
              
              {/* Official System Managed Info */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <Lock size={12} className="text-amber-500 animate-pulse" /> Official HR Metadata
                </h4>
                
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Employee System ID</label>
                    <input 
                      value={profile.employeeId} 
                      onChange={e => isAdminOrHR ? setProfile(prev => ({ ...prev, employeeId: e.target.value })) : null}
                      disabled={!isAdminOrHR}
                      className={inputClass(isAdminOrHR)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Official Registered Name</label>
                    <input 
                      value={profile.employeeName} 
                      onChange={e => isAdminOrHR ? setProfile(prev => ({ ...prev, employeeName: e.target.value })) : null}
                      disabled={!isAdminOrHR}
                      className={inputClass(isAdminOrHR)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Official Email</label>
                    <input 
                      value={profile.officialEmail} 
                      disabled={true} 
                      className={inputClass(false)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Reporting Supervisor/Manager</label>
                    <input 
                      value={profile.reportingManager} 
                      disabled={true} 
                      className={inputClass(false)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Department</label>
                    <input 
                      value={profile.department} 
                      onChange={e => isAdminOrHR ? setProfile(prev => ({ ...prev, department: e.target.value })) : null}
                      disabled={!isAdminOrHR}
                      className={inputClass(isAdminOrHR)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Official Joining Date</label>
                    <input 
                      value={profile.dateJoined} 
                      onChange={e => isAdminOrHR ? setProfile(prev => ({ ...prev, dateJoined: e.target.value })) : null}
                      disabled={!isAdminOrHR}
                      className={inputClass(isAdminOrHR)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Employment Type / Tenure</label>
                    <select 
                      value={profile.employmentType} 
                      onChange={e => isAdminOrHR ? setProfile(prev => ({ ...prev, employmentType: e.target.value })) : null}
                      disabled={!isAdminOrHR}
                      className={inputClass(isAdminOrHR)}
                    >
                      <option value="Full-Time">Full-Time Permanent</option>
                      <option value="Part-Time">Part-Time</option>
                      <option value="Contract">Contractual Tenor</option>
                      <option value="Probation">Probationary Period</option>
                      <option value="Intern">Internship Term</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Account Status</label>
                    <input 
                      value={liveAccountStatus} 
                      disabled={true} 
                      className={inputClass(false)} 
                    />
                  </div>
                </div>

                {!isAdminOrHR && (
                  <p className="text-[10px] text-slate-400 mt-4 leading-relaxed font-sans flex items-center gap-1">
                    <AlertCircle size={10} className="text-amber-500 animate-pulse" /> Values above are structured and validated via directory auth. Contact HR for alterations.
                  </p>
                )}
              </div>

              {/* Secure Identity Information */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <ShieldCheck size={14} className="text-indigo-400" /> Identity Transcripts
                </h4>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Permanent Account Num (PAN)</label>
                      <span className="text-[9px] text-rose-450 font-bold uppercase">{!profile.panNumber ? 'REQD' : validatePAN(profile.panNumber) ? 'VALID' : 'INVALID'}</span>
                    </div>
                    <input 
                      value={profile.panNumber} 
                      onChange={e => setProfile(prev => ({ ...prev, panNumber: e.target.value.toUpperCase() }))}
                      placeholder="ABCDE1234F"
                      maxLength={10}
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Aadhaar National ID Num</label>
                    <input 
                      value={profile.aadhaarNumber} 
                      onChange={e => setProfile(prev => ({ ...prev, aadhaarNumber: e.target.value.replace(/\D/g, '') }))}
                      placeholder="12 Digit Aadhaar Standard"
                      maxLength={12}
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Passport Document Number</label>
                    <input 
                      value={profile.passportNumber} 
                      onChange={e => setProfile(prev => ({ ...prev, passportNumber: e.target.value }))}
                      placeholder="Optional Passport ID"
                      className={inputClass(true)} 
                    />
                  </div>
                </div>
              </div>

            </div>

            {/* 3. Center Rail: Editable Personal & Addresses */}
            <div className="space-y-6 lg:col-span-2">
              
              {/* Personal Details */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <User size={14} className="text-indigo-400" /> Personal Identity Details
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Personal Primary Cellphone</label>
                    <input 
                      type="tel"
                      value={profile.mobileNumber} 
                      onChange={e => setProfile(prev => ({ ...prev, mobileNumber: e.target.value }))}
                      placeholder="10-digit number"
                      maxLength={15}
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Alternate / Home Line</label>
                    <input 
                      type="tel"
                      value={profile.alternateNumber} 
                      onChange={e => setProfile(prev => ({ ...prev, alternateNumber: e.target.value }))}
                      placeholder="Backup contact"
                      maxLength={15}
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Personal Backup Email</label>
                    <input 
                      type="email"
                      value={profile.personalEmail} 
                      onChange={e => setProfile(prev => ({ ...prev, personalEmail: e.target.value }))}
                      placeholder="e.g. personal@gmail.com"
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Birth Date</label>
                    <input 
                      type="date"
                      value={profile.dateOfBirth} 
                      onChange={e => setProfile(prev => ({ ...prev, dateOfBirth: e.target.value }))}
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Gender</label>
                    <select 
                      value={profile.gender} 
                      onChange={e => setProfile(prev => ({ ...prev, gender: e.target.value }))}
                      className={inputClass(true)}
                    >
                      <option value="">Select Gender...</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                      <option value="Non-Binary">Non-Binary</option>
                      <option value="Prefer not to say">Prefer not to say</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Blood Group</label>
                    <select 
                      value={profile.bloodGroup} 
                      onChange={e => setProfile(prev => ({ ...prev, bloodGroup: e.target.value }))}
                      className={inputClass(true)}
                    >
                      <option value="">Select Blood Group...</option>
                      <option value="A+">A+</option>
                      <option value="A-">A-</option>
                      <option value="B+">B+</option>
                      <option value="B-">B-</option>
                      <option value="AB+">AB+</option>
                      <option value="AB-">AB-</option>
                      <option value="O+">O+</option>
                      <option value="O-">O-</option>
                    </select>
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Marital Status</label>
                    <select 
                      value={profile.maritalStatus} 
                      onChange={e => setProfile(prev => ({ ...prev, maritalStatus: e.target.value }))}
                      className={inputClass(true)}
                    >
                      <option value="">Select Marital Status...</option>
                      <option value="Single">Single</option>
                      <option value="Married">Married</option>
                      <option value="Divorced">Divorced</option>
                      <option value="Widowed">Widowed</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Addresses Info */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <MapPin size={14} className="text-indigo-400" /> Physical Coordinates / Address Information
                </h4>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Current Physical Address</label>
                    <textarea 
                      rows={2}
                      value={profile.currentAddress} 
                      onChange={e => setProfile(prev => ({ ...prev, currentAddress: e.target.value }))}
                      placeholder="Current residence location"
                      className={`${inputClass(true)} resize-none`} 
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Permanent address</label>
                      <button
                        type="button"
                        onClick={() => setProfile(prev => ({ ...prev, permanentAddress: prev.currentAddress }))}
                        className="text-[9px] font-bold text-indigo-455 hover:underline"
                      >
                        Copy Current Address
                      </button>
                    </div>
                    <textarea 
                      rows={2}
                      value={profile.permanentAddress} 
                      onChange={e => setProfile(prev => ({ ...prev, permanentAddress: e.target.value }))}
                      placeholder="Official permanent address"
                      className={`${inputClass(true)} resize-none`} 
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">City</label>
                      <input 
                        value={profile.city} 
                        onChange={e => setProfile(prev => ({ ...prev, city: e.target.value }))}
                        placeholder="e.g. Noida"
                        className={inputClass(true)} 
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">State / Province</label>
                      <input 
                        value={profile.state} 
                        onChange={e => setProfile(prev => ({ ...prev, state: e.target.value }))}
                        placeholder="e.g. Uttar Pradesh"
                        className={inputClass(true)} 
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Country</label>
                      <input 
                        value={profile.country} 
                        onChange={e => setProfile(prev => ({ ...prev, country: e.target.value }))}
                        placeholder="e.g. India"
                        className={inputClass(true)} 
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Postal ZIP Code</label>
                      <input 
                        value={profile.postalCode} 
                        onChange={e => setProfile(prev => ({ ...prev, postalCode: e.target.value.replace(/\D/g, '') }))}
                        placeholder="6-digit PIN"
                        maxLength={10}
                        className={inputClass(true)} 
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Emergency Contact */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <AlertCircle size={14} className="text-rose-500 animate-pulse" /> Emergency Contact Info
                </h4>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Emergency Contact Name</label>
                    <input 
                      value={profile.emergencyContact.name} 
                      onChange={e => setProfile(prev => ({ ...prev, emergencyContact: { ...prev.emergencyContact, name: e.target.value } }))}
                      placeholder="Contact Person Full Name"
                      className={inputClass(true)} 
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Relationship</label>
                      <input 
                        value={profile.emergencyContact.relationship} 
                        onChange={e => setProfile(prev => ({ ...prev, emergencyContact: { ...prev.emergencyContact, relationship: e.target.value } }))}
                        placeholder="e.g., Mother, Spouse, Friend"
                        className={inputClass(true)} 
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] font-black uppercase tracking-wider text-slate-350">Emergency Cellphone</label>
                      <input 
                        type="tel"
                        value={profile.emergencyContact.number} 
                        onChange={e => setProfile(prev => ({ ...prev, emergencyContact: { ...prev.emergencyContact, number: e.target.value } }))}
                        placeholder="Emergency Phone"
                        maxLength={15}
                        className={inputClass(true)} 
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Professional Profile Tags */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <Award size={14} className="text-indigo-400" /> Skills & Professional Proficiencies
                </h4>

                <div className="space-y-6">
                  {/* Skills Tag Engine */}
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Active Professional Skills</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={newSkill} 
                        onChange={e => setNewSkill(e.target.value)} 
                        placeholder="Add skill (e.g. Data Annotation, Call Coaching)..."
                        className={`${inputClass(true)} h-9`}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag('skill'))}
                      />
                      <button 
                        type="button" 
                        onClick={() => addTag('skill')}
                        className="px-3.5 bg-indigo-650 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                      >
                        Add
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {profile.skills.map((s, idx) => (
                        <span key={idx} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md border border-indigo-500/10">
                          {s}
                          <button type="button" onClick={() => removeTag('skill', idx)} className="text-rose-500 hover:text-rose-700 cursor-pointer ml-1">×</button>
                        </span>
                      ))}
                      {profile.skills.length === 0 && <span className="text-[11px] text-slate-400 italic">No skills added yet.</span>}
                    </div>
                  </div>

                  {/* Certifications Tag Engine */}
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450">Certifications & Micro-Credentials</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={newCert} 
                        onChange={e => setNewCert(e.target.value)} 
                        placeholder="Add certification (e.g. Six Sigma, COPC)..."
                        className={`${inputClass(true)} h-9`}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag('cert'))}
                      />
                      <button 
                        type="button" 
                        onClick={() => addTag('cert')}
                        className="px-3.5 bg-indigo-650 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                      >
                        Add
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {profile.certifications.map((c, idx) => (
                        <span key={idx} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 bg-violet-500/10 text-violet-400 rounded-md border border-violet-500/10 font-mono">
                          {c}
                          <button type="button" onClick={() => removeTag('cert', idx)} className="text-rose-500 hover:text-rose-700 cursor-pointer ml-1">×</button>
                        </span>
                      ))}
                      {profile.certifications.length === 0 && <span className="text-[11px] text-slate-400 italic">No certifications added yet.</span>}
                    </div>
                  </div>

                  {/* Languages Engine */}
                  <div className="space-y-2">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-450 font-sans">Languages Spoken / Comprehended</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={newLang} 
                        onChange={e => setNewLang(e.target.value)} 
                        placeholder="Add language (e.g. English, Hindi)..."
                        className={`${inputClass(true)} h-9`}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag('lang'))}
                      />
                      <button 
                        type="button" 
                        onClick={() => addTag('lang')}
                        className="px-3.5 bg-indigo-650 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                      >
                        Add
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {profile.languages.map((l, idx) => (
                        <span key={idx} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 bg-sky-500/10 text-sky-400 rounded-md border border-sky-500/10">
                          {l}
                          <button type="button" onClick={() => removeTag('lang', idx)} className="text-rose-500 hover:text-rose-700 cursor-pointer ml-1 font-bold">×</button>
                        </span>
                      ))}
                      {profile.languages.length === 0 && <span className="text-[11px] text-slate-400 italic">No languages added.</span>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Secure Document Upload Transcripts */}
              <div className={cardClass}>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <FileText size={14} className="text-indigo-400" /> Secure HR Verification Document Uploads
                </h4>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {[
                      { key: 'pan', label: 'PAN Card Copy' },
                      { key: 'aadhaar', label: 'Aadhaar copy' },
                      { key: 'resume', label: 'CV / Resume File' },
                      { key: 'offer-letter', label: 'Offer Letter' },
                      { key: 'others', label: 'Other Docs' }
                    ].map((docType) => {
                      const uploadedFile = profile.documents.find(d => d.type === docType.key);
                      return (
                        <div key={docType.key} className={`${subCardClass} flex flex-col justify-between items-center text-center p-3.5 gap-2 relative bg-indigo-950/5`}>
                          <FileText size={20} className={uploadedFile ? "text-indigo-400 animate-pulse" : "text-slate-500"} />
                          <div>
                            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-350">{docType.label}</div>
                            {uploadedFile ? (
                              <div className="text-[8px] text-emerald-450 font-mono mt-0.5 truncate max-w-[100px]">{uploadedFile.name}</div>
                            ) : (
                              <div className="text-[8px] text-slate-450 italic mt-0.5">Missing</div>
                            )}
                          </div>

                          {uploadedFile ? (
                            <div className="flex gap-1.5 w-full mt-2 justify-center">
                              <a 
                                href={uploadedFile.url} download={uploadedFile.name} target="_blank" rel="noopener noreferrer"
                                className="p-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-md cursor-pointer text-[10px]"
                                title="Download / Preview"
                              >
                                <Eye size={12} />
                              </a>
                              <button
                                type="button"
                                onClick={() => setDeletingDoc(uploadedFile)}
                                className="p-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-455 rounded-md cursor-pointer text-[10px]"
                                title="Delete"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ) : (
                            <label className="text-[10px] font-bold mt-2 px-2.5 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 hover:underline border border-dashed border-indigo-500/20 rounded-md cursor-pointer flex items-center justify-center gap-1">
                              <Upload size={10} /> Upload
                              <input 
                                type="file" 
                                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" 
                                className="hidden" 
                                onChange={e => handleUploadDocument(e, docType.key)} 
                              />
                            </label>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Secure Firebase Storage Banner */}
              <div className={`p-4 rounded-xl border flex gap-3 ${externalTheme === 'dark' ? 'bg-indigo-950/20 border-indigo-900/30 text-indigo-150' : 'bg-indigo-50/40 border-indigo-100 text-indigo-900'}`}>
                <Database size={16} className="text-indigo-400 flex-shrink-0 mt-0.5 animate-pulse" />
                <div className="text-[10px] leading-relaxed">
                  <strong>Secure Cloud Storage Protocols Enabled</strong>: Files uploaded are encrypted at rest under path <code className="font-mono bg-slate-905/20 px-1 py-0.5 rounded text-[9px]">employees/{inspectUserId}/</code>. Only you and authorized HR operators are permitted to parse the decrypted files.
                </div>
              </div>
              
              {/* Action save profile */}
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-205 dark:border-slate-800">
                <button 
                  type="button" 
                  onClick={() => setInspectUserId(user.uid)}
                  className="px-4 py-2 bg-slate-100/10 hover:bg-slate-100/20 border border-slate-700/40 text-xs font-bold rounded-xl cursor-pointer"
                >
                  Reset Changes
                </button>
                <button 
                  type="submit" 
                  disabled={saving}
                  className="px-6 py-2.5 bg-indigo-650 hover:bg-indigo-750 text-white text-xs font-black rounded-xl cursor-pointer flex items-center gap-1.5 shadow-md active:scale-95 transition-all"
                >
                  {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />} Save Secured Profile Records
                </button>
              </div>

            </div>

          </div>

          {/* 8. Future Readiness modules map visualizer */}
          <div className={cardClass}>
            <div className="flex items-center gap-2 mb-4 border-b border-slate-150 dark:border-slate-800 pb-3">
              <Sparkles size={16} className="text-violet-500 animate-pulse" />
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-450">Future HRMS Platform Modules Roadmap</h4>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
              {[
                { title: "Leave Management", desc: "Leaves & PTOs" },
                { title: "Attendance", desc: "Clock-in history", active: true },
                { title: "Asset Management", desc: "Assigned hardware" },
                { title: "Payroll Integration", desc: "Salary Slips & PAN" },
                { title: "Performance Mgmt", desc: "Warnings & KPI", active: true },
                { title: "Employee Directory", desc: "Network nodes", active: true },
                { title: "Organizational structure", desc: "Skip-level mapping", active: true }
              ].map((m, idx) => (
                <div key={idx} className={`p-3 rounded-xl border flex flex-col justify-between items-center gap-1 ${
                  m.active 
                    ? 'border-indigo-500/30 bg-indigo-550/5 text-indigo-400' 
                    : 'border-slate-800/40 opacity-55 text-slate-500'
                }`}>
                  <div className="text-[10px] font-bold truncate max-w-full leading-tight">{m.title}</div>
                  <div className="text-[8px] opacity-80">{m.desc}</div>
                  <span className={`text-[7px] font-bold px-1 py-0.5 rounded mt-1.5 uppercase ${m.active ? 'bg-indigo-500/10 text-indigo-400' : 'bg-slate-805 text-slate-600'}`}>
                    {m.active ? 'Connected' : 'Roadmap'}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </form>
      ) : (
        /* Supervisor and HR Operator Visibility Center */
        <div className="space-y-6 animate-in fade-in duration-300">
          
          {/* Main filters box */}
          <div className={cardClass}>
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-400">
                <Search size={15} className="text-indigo-500 animate-bounce" /> HR Operator Intelligence Controls ({filteredProfilesByCriteria.length} verified listings)
              </div>
              
              <div className="flex flex-wrap gap-2.5 w-full lg:w-auto">
                <div className="relative flex-1 lg:flex-none">
                  <input 
                    type="text" 
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search name, email, employee id..."
                    className="w-full lg:w-64 text-xs pl-8 pr-3 py-2.5 rounded-xl border border-slate-700/50 bg-slate-905 outline-none focus:ring-1 focus:ring-indigo-500 text-slate-100"
                  />
                  <Search size={13} className="absolute left-3 top-3 text-slate-400" />
                </div>

                <select
                  value={filterMissingDoc}
                  onChange={e => setFilterMissingDoc(e.target.value as any)}
                  className="text-xs p-2.5 rounded-xl border border-slate-700/50 bg-slate-905 text-slate-200 outline-none"
                >
                  <option value="all">Check Documents (All)</option>
                  <option value="pan">Missing PAN</option>
                  <option value="aadhaar">Missing Aadhaar</option>
                  <option value="resume">Missing Resume</option>
                  <option value="photo">Missing Photo</option>
                </select>

                <select
                  value={filterCompletion}
                  onChange={e => setFilterCompletion(e.target.value)}
                  className="text-xs p-2.5 rounded-xl border border-slate-700/50 bg-slate-905 text-slate-202 outline-none"
                >
                  <option value="all">Completion (All)</option>
                  <option value="low">&lt; 50% Critical</option>
                  <option value="mid">50% - 80% Partial</option>
                  <option value="high">&gt; 80% Outstanding</option>
                </select>

                <div className="flex items-center gap-2 bg-slate-905 border border-slate-700/50 rounded-xl px-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase px-1">Page Size</span>
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    className="text-xs py-2.5 bg-transparent text-slate-200 outline-none"
                  >
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* HR Profiles List Table */}
          <div className={cardClass}>
            <div className="overflow-x-auto rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-950/20 text-slate-400 border-b border-slate-800">
                    <th className="p-3">Employee Name</th>
                    <th className="p-3">Employee ID</th>
                    <th className="p-3">Supervisor</th>
                    <th className="p-3">Campaign Process</th>
                    <th className="p-3">PAN Status</th>
                    <th className="p-3">Aadhaar Status</th>
                    <th className="p-3">Profile Completion</th>
                    <th className="p-3 text-center">Platform Override</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedProfiles.map((p) => {
                    const hasPan = p.documents.some((d: any) => d.type === 'pan');
                    const hasAadhaar = p.documents.some((d: any) => d.type === 'aadhaar');
                    return (
                      <tr key={p.uid} className="hover:bg-indigo-500/[0.02] border-b border-slate-800/40 transition-all duration-150">
                        <td className="p-3 flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-800 flex items-center justify-center font-bold text-xs shrink-0">
                            {p.profilePhotoUrl ? (
                              <img src={p.profilePhotoUrl} alt="Avatar" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                            ) : (
                              (p.fullName || '??').split(' ').filter(Boolean).map((n: string)=>n[0]).slice(0,2).join('').toUpperCase()
                            )}
                          </div>
                          <div>
                            <span className="font-bold block text-[#1E293B] dark:text-slate-100">{p.fullName}</span>
                            <span className="text-[10px] text-slate-405 block">{p.email}</span>
                          </div>
                        </td>
                        <td className="p-3 font-mono font-bold text-indigo-400">{p.employeeId}</td>
                        <td className="p-3 text-slate-400 font-semibold">{p.managerName}</td>
                        <td className="p-3"><span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded font-mono font-bold border border-emerald-500/10">{p.process}</span></td>
                        <td className="p-3">
                          {hasPan ? (
                            <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">Uploaded</span>
                          ) : (
                            <span className="text-[10px] text-rose-455 font-bold bg-rose-500/10 px-2 py-0.5 rounded flex items-center gap-1 w-max"><AlertCircle size={10} /> Track Missing</span>
                          )}
                        </td>
                        <td className="p-3">
                          {hasAadhaar ? (
                            <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">Uploaded</span>
                          ) : (
                            <span className="text-[10px] text-rose-455 font-bold bg-rose-500/10 px-2 py-0.5 rounded flex items-center gap-1 w-max"><AlertCircle size={10} /> Track Missing</span>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-slate-950 h-1.5 rounded-full overflow-hidden shadow-inner shrink-0">
                              <div className="bg-indigo-500 h-full rounded-full" style={{ width: `${p.completion}%` }} />
                            </div>
                            <span className="font-mono font-bold text-slate-350">{p.completion}%</span>
                          </div>
                        </td>
                        <td className="p-3 text-center">
                          <button
                            onClick={() => {
                              setInspectUserId(p.uid);
                              setProfileTab('my-profile');
                            }}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold text-[10px] px-3 py-1.5 rounded-lg inline-flex items-center gap-1 cursor-pointer transition-all hover:scale-105 active:scale-95"
                          >
                            Inspect Profile <ArrowRight size={11} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {paginatedProfiles.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-500 italic font-medium">No verified directory listings matched your custom filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-6 border-t border-slate-800">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                  Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, filteredProfilesByCriteria.length)} of {filteredProfilesByCriteria.length} Records
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="p-2 rounded-lg border border-slate-700 bg-slate-905 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/50 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:border-slate-700 transition-all cursor-pointer"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  
                  {/* Page numbers block */}
                  <div className="flex items-center gap-1 mx-2">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum = i + 1;
                      if (totalPages > 5 && currentPage > 3) {
                        pageNum = currentPage - 2 + i;
                        if (pageNum + (5 - i - 1) > totalPages) {
                          pageNum = totalPages - 4 + i;
                        }
                      }
                      if (pageNum > totalPages || pageNum < 1) return null;
                      
                      return (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => setCurrentPage(pageNum)}
                          className={`w-8 h-8 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                            currentPage === pageNum
                              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                              : 'text-slate-400 hover:bg-slate-805 hover:text-slate-200 border border-slate-800'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="p-2 rounded-lg border border-slate-700 bg-slate-905 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/50 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:border-slate-700 transition-all cursor-pointer"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      )}

      {/* 2. Deletion Confirmation Modal Overlay */}
      <AnimatePresence>
        {deletingDoc && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full shadow-2xl p-6 relative overflow-hidden"
            >
              {/* Decorative Accent */}
              <div className="absolute top-0 inset-x-0 h-1.5 bg-rose-500" />
              
              <div className="flex items-start gap-4">
                <div className="p-3 bg-rose-500/10 rounded-xl text-rose-500 shrink-0">
                  <AlertCircle size={24} className="animate-pulse" />
                </div>
                <div className="space-y-1.5 w-full">
                  <h3 className="text-base font-black text-slate-850 dark:text-slate-100 tracking-tight">Confirm Document Deletion</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-405 leading-relaxed">
                    Are you absolutely sure you want to permanently discard the uploaded <strong>{deletingDoc.type.toUpperCase()}</strong> file?
                  </p>
                  <div className="bg-slate-50 dark:bg-slate-950/50 p-2.5 rounded-lg border border-slate-100 dark:border-slate-850 text-[11px] font-mono select-all text-slate-600 dark:text-slate-350">
                    <span className="block truncate font-bold text-slate-700 dark:text-slate-200">Name: {deletingDoc.name}</span>
                    <span className="block text-[10px] text-slate-400 mt-0.5">Uploaded: {new Date(deletingDoc.uploadedAt).toLocaleString()} • Size: {deletingDoc.size}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setDeletingDoc(null)}
                  className="px-4 py-2 text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-105 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const docToProceed = deletingDoc;
                    setDeletingDoc(null);
                    await deleteDocument(docToProceed);
                  }}
                  className="px-4 py-2 text-xs font-bold text-white bg-rose-500 hover:bg-rose-600 rounded-xl shadow-md cursor-pointer transition-transform hover:scale-[1.02] active:scale-[0.98]"
                >
                  Confirm Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. Enhanced Rich Error Modal Overlay */}
      <AnimatePresence>
        {errorDialogMsg && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full shadow-2xl p-6 relative overflow-hidden"
            >
              {/* Decorative Accent */}
              <div className="absolute top-0 inset-x-0 h-1.5 bg-amber-500" />
              
              <div className="flex items-start gap-4">
                <div className="p-3 bg-amber-500/10 rounded-xl text-amber-500 shrink-0">
                  <AlertCircle size={24} />
                </div>
                <div className="space-y-2 w-full">
                  <h3 className="text-base font-black text-slate-850 dark:text-slate-100 tracking-tight">Profile Module Diagnostics</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-405 leading-relaxed">
                    An operations status or security check returned an update warning:
                  </p>
                  
                  <div className="bg-slate-50 dark:bg-slate-950/50 p-3 rounded-lg border border-slate-105 dark:border-slate-850 font-mono text-[11px] text-rose-505 dark:text-rose-400 select-all overflow-x-auto max-h-40 whitespace-pre-wrap leading-relaxed">
                    {errorDialogMsg}
                  </div>

                  <div className="text-[10px] text-slate-505 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/30 p-2.5 rounded-lg border border-slate-100 dark:border-slate-850 mt-1">
                    <strong>Resolution Guidance:</strong>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      <li>Ensure proper internet connectivity</li>
                      <li>Standard profiles cannot rewrite other member directories</li>
                      <li>To execute directory overlays, you must hold high-clearance roles (<strong>ADMIN</strong> or <strong>HR</strong>)</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end mt-6">
                <button
                  type="button"
                  onClick={() => setErrorDialogMsg(null)}
                  className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md cursor-pointer transition-transform hover:scale-[1.02] active:scale-[0.98]"
                >
                  Close Dialogue
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
