import React, { useState, useEffect, useRef } from 'react';
import { 
  ClipboardCheck, 
  ExternalLink, 
  SkipForward, 
  CheckCircle2, 
  AlertTriangle,
  History,
  ShieldAlert,
  ArrowRight,
  MessageSquare,
  User,
  Search,
  ChevronRight,
  MoreVertical,
  X,
  Clock,
  ChevronLeft,
  Save,
  Plus,
  Minus,
  Calendar,
  Sparkles,
  BrainCircuit,
  Lightbulb
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { MultiSelectDropdown } from '../components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { calculateQuality, getAuditStatus, getTaskUrl } from '../lib/formulas';
import { MOCK_CONFIG } from '../lib/sample-data';
import { UserRole, AuditRecord, DisputeStatus, DisputeHistory, UserProfile, QAAlignment, SamplingTask } from '../types';
import DisputeWorkflow from '../components/DisputeWorkflow';
import { analyzePrecision } from '../services/geminiService';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import WarningManager from '../components/WarningManager';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface QAViewProps {
  activeTab: string;
  tasks: SamplingTask[];
  onTasksUpdate: (tasks: any[]) => void;
  onAuditUpdate: (audit: AuditRecord) => void;
  user: UserProfile;
  alignments: QAAlignment[];
  productions?: any[];
  auditLogs?: any[];
  goToTab?: (tab: string) => void;
  editingAudit?: AuditRecord | null;
  onCancelEdit?: () => void;
}

export default function QAView({ 
  activeTab, 
  tasks, 
  onTasksUpdate, 
  onAuditUpdate, 
  user,
  alignments,
  productions = [],
  auditLogs = [],
  goToTab,
  editingAudit,
  onCancelEdit
}: QAViewProps) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [searchAgent, setSearchAgent] = useState('');
  const [currentTask, setCurrentTask] = useState<SamplingTask | null>(null);
  const [auditStep, setAuditStep] = useState<1 | 2>(1);
  const [auditOpen, setAuditOpen] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiTips, setAiTips] = useState<string[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const [auditData, setAuditData] = useState({
    compErrorCount: 0,
    mpqcErrorCount: 0,
    status: 'Correct' as 'Correct' | 'Incorrect' | 'Tech Issue',
    qaComment: '',
    rowNo: '',
    errorType: [] as string[],
    guideline: [] as string[],
    theme: [] as string[],
    isOnPip: false,
    quality: 100
  });

  const toggleSelection = (field: 'errorType' | 'guideline' | 'theme', value: string) => {
    setAuditData(prev => ({
      ...prev,
      [field]: prev[field].includes(value) 
        ? prev[field].filter(v => v !== value) 
        : [...prev[field], value]
    }));
  };

  const [globalConfig, setGlobalConfig] = useState<{
    errorTypes: string[];
    guidelines: string[];
    themes: string[];
  } | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const docRef = doc(db, 'config', 'master');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setGlobalConfig(docSnap.data() as any);
        }
      } catch (e) {
        handleFirestoreError(e, OperationType.GET, 'config/master');
      }
    };
    fetchConfig();
  }, []);

  // Handle Edit Audit
  useEffect(() => {
    if (editingAudit) {
      // Find the associated task
      const associatedTask = tasks.find(t => t.taskId === editingAudit.taskId);
      if (associatedTask) {
        setCurrentTask(associatedTask);
      } else {
        // Create a dummy task object if original task not found in current list
        setCurrentTask({
          id: `task-${editingAudit.taskId}`,
          taskId: editingAudit.taskId,
          qvName: editingAudit.qvName,
          vertical: editingAudit.vertical,
          sellerId: editingAudit.sellerId,
          categoryGroup: editingAudit.categoryGroup,
          auditUrl: editingAudit.auditUrl,
          rows: editingAudit.rows,
          rowsPassed: editingAudit.rowsPassed,
          rowsFailed: editingAudit.rowsFailed,
          attributesEdited: editingAudit.attributesEdited || 0,
          imageReshuffle: editingAudit.imageReshuffle || false,
          status: 'Completed',
          sourceFileId: '',
          createdAt: new Date().toISOString()
        } as SamplingTask);
      }
      
      setAuditData({
        compErrorCount: editingAudit.compErrorCount,
        mpqcErrorCount: editingAudit.mpqcErrorCount,
        status: editingAudit.status,
        qaComment: editingAudit.qaComment,
        rowNo: editingAudit.rowNo || '',
        errorType: editingAudit.errorType === 'None' ? [] : editingAudit.errorType.split(', ').filter(Boolean),
        guideline: editingAudit.guideline === 'N/A' || editingAudit.guideline === 'None' ? [] : editingAudit.guideline.split(', ').filter(Boolean),
        theme: editingAudit.theme === 'N/A' || editingAudit.theme === 'None' ? [] : editingAudit.theme.split(', ').filter(Boolean),
        isOnPip: editingAudit.isOnPip || false,
        quality: editingAudit.quality
      });
      setAuditOpen(true);
      setAuditStep(2); // Jump to scoring step
    }
  }, [editingAudit, tasks]);

// Global config for dropdowns based on provided taxonomy
  const fallbackConfig = {
    errorTypes: ['MP Error', 'Compliance'],
    guidelines: [
      'Incorrect product description',
      'Adjustable mismatch with respect to image',
      'Air Freshener Type mismatch with respect to image',
      'Antenna Slot Available mismatch with respect to image',
      'anti_bacterial Mismatch',
      'application_area mismatch with respect to image',
      'applied_for mismatch with respect to image',
      'Assorted/customized product',
      'Author mismatch with respect to image',
      'aux_cable_included mismatch with respect to image',
      'Barefoot model images are not allowed',
      'Battery operated mismatch with respect to image',
      'battery type mismatch with respect to image',
      'battery_backup mismatch',
      'battery_capacity mismatch',
      'belt_included mismatch with respect to image',
      'Binding mismatch with respect to image',
      'Bluetooth mismatch with respect to image',
      'body_length mismatch with respect to image',
      'Border Image Issues',
      'bottom_type mismatch with respect to image',
      'Bowl Type mismatch with respect to image',
      'Brand Abuse Detection',
      'Brand Color mismatch with respect to image',
      'Brand name mismatch or misuse',
      'Bulb Shape mismatch with respect to image',
      'capacity mismatch with respect to image',
      'card_class mismatch',
      'Cartridge_type mismatch',
      'Caster Type mismatch',
      'Category mismatch with respect to image',
      'Chain Included mismatch',
      'Character mismatch',
      'Chocolate Included value mismatch',
      'clock_speed mismatch',
      'Closure mismatch',
      'Color mismatch',
      'Compatible_brand_name issues',
      'Composition Mismatch w.r.t. image',
      'Configuration mismatch',
      'Connector mismatch',
      'Container Type mismatch',
      'contributor mismatch',
      'Covid sanitary Product check',
      'Dangereous Listings',
      'Depth mismatch',
      'Design Code should be same for all Size Variants',
      'Design mismatch with respect to image',
      'designed for mismatch',
      'Detachable Cable mismatch',
      'Dial Color attribute value mismatch',
      'Dial Shape mismatch',
      'Diameter mismatch',
      'diamond_cut mismatch',
      'Dietary Preference mismatch',
      'Different image views/ angles',
      'Dinnerware Included mismatch',
      'display mismatch',
      'display_size mismatch',
      'Disposable mismatch',
      'Distorted images',
      'Distressed value mismatch',
      'Diya Included mismatch',
      'dual_camera_lens mismatch',
      'Duplicate Listings/Images',
      'Edition mismatch',
      'Electric mismatch',
      'Embargo Words Detection',
      'Finish mismatch',
      'Finish Type mismatch',
      'fire_resistant mismatch',
      'fit mismatch',
      'Flat shoot images not allowed',
      'Flavor mismatch',
      'foldable mismatch',
      'Food Preference mismatch',
      'Food Safety - Product with Banned Ingredients',
      'Form mismatch',
      'Fragrance mismatch',
      'Frame Material mismatch',
      'FSSAI number mismatch',
      'FSSAI/Veg Non Veg Logo Missing',
      'Gemstone mismatch',
      'Genre mismatch',
      'Glass Type mismatch',
      'Global auto block for Prohibited words',
      'Hair Type mismatch',
      'Handle Material mismatch',
      'Hanger/Holder Images not Accepted',
      'Head-cut Images not allowed',
      'Headphone Design mismatch',
      'Heel Design mismatch',
      'Height mismatch',
      'Hooded mismatch',
      'Human intervention images not allowed',
      'Ideal For mismatch',
      'Image background issues',
      'Image Clarity/ Blur',
      'Image coverage issues',
      'Image Profanity',
      'Image/model homogeneity',
      'Images disrespecting national flag',
      'Images hurting religious & political sentiments',
      'Images with infographics',
      'Images with mrp mfg & exp date',
      'Images with watermark',
      'Incorrect choli_pattern',
      'Incorrect composition',
      'Incorrect connector',
      'Incorrect Dimensions',
      'Incorrect fabric_details',
      'Incorrect Fail',
      'Incorrect guideline Selected',
      'Incorrect license_number',
      'Incorrect nutrient_content',
      'Incorrect power cord included',
      'Incorrect Prescription Required value',
      'Incorrect usage_instructions',
      'Incorrect vertical',
      'Incorrect Warranty Information',
      'installation_type mismatch',
      'internal_storage mismatch',
      'Inverted Image',
      'Keyboard type mismatch',
      'Kurta Type mismatch',
      'Lamp Type mismatch',
      'Language mismatch',
      'Legal Issues',
      'Length mismatch',
      'Lethal Product',
      'Lifestyle Image not Accepted',
      'Mandatory Images not Provided',
      'Mannequin images are not allowed',
      'Manufacturing Address Missing',
      'Material mismatch',
      'Max Shelf Life mismatch',
      'Micron Rating mismatch',
      'Microwave Safe mismatch',
      'model name mismatch',
      'monitor type mismatch',
      'Mount Type mismatch',
      'Multiple views not accepted',
      'network_type mismatch',
      'no_of_cores mismatch',
      'Number of Bulbs mismatch',
      'Number of Compartments mismatch',
      'Number of containers mismatch',
      'Number of Cups mismatch',
      'Number of Sheets mismatch',
      'Number of T-Shirts mismatch',
      'Nutritional/Ingredient Info Missing',
      'Occasion mismatch',
      'OFAC Embargo Check',
      'operating_system mismatch',
      'organic mismatch',
      'Orientation mismatch',
      'Outer Fabric mismatch',
      'Pack of value mismatch',
      'Painting Theme mismatch',
      'Pan Type mismatch',
      'Partial images',
      'Pattern mismatch',
      'Pet Type mismatch',
      'piercing_required mismatch',
      'Plastic or Thermocol Product',
      'Poor Quality Image',
      'Power Source mismatch',
      'Prescription Required',
      'Primary Material mismatch',
      'processor_brand mismatch',
      'Product Homogenity Issues',
      'Product not in focus',
      'Prohibited Items Auto-Block',
      'Promotional/Additional content in image',
      'ram mismatch',
      'resolution mismatch',
      'Reversible mismatch',
      'sales_package mismatch',
      'screen_size mismatch',
      'Seam Type mismatch',
      'shade mismatch',
      'Shape mismatch',
      'Shelf Life mismatch',
      'Side Mirror Pockets mismatch',
      'Sleeve mistach',
      'Stiching type mismatch',
      'strap_color mismatch',
      'style_code mismatch',
      'Suitable For mismatch',
      'system_memory mismatch',
      'Tea Form mismatch',
      'Title mismatch',
      'Type mismatch',
      'Universal Guideline',
      'usage mismatch',
      'vehicle_model_year mismatch',
      'weight mismatch',
      'Width mismatch',
      'Wired Wireless mismatch'
    ],
    themes: [
      'Missed to fail for Brand Abuse',
      'Missed to fail for Brand Name Mismatch',
      'Incorrect fail for Brand Abuse',
      'Incorrect fail for Brand Name Mismatch',
      'Missed to Edit for Color',
      'Incorrect fail for Color',
      'Missed to Edit for Pattern',
      'Incorrect fail for Pattern',
      'Missed to Edit for Theme',
      'Incorrect fail for Theme',
      'Missed to fail for Watermark',
      'Incorrect fail for Watermark',
      'Missed to fail for Infographics',
      'Incorrect fail for Infographics',
      'Missed to fail for Model Homogeneity',
      'Incorrect fail for Model Homogeneity',
      'Missed to fail for Product Homogeneity',
      'Incorrect fail for Product Homogeneity',
      'Missed to fail for Promotional/Additional/Freebie',
      'Incorrect fail for Promotional/Additional/Freebie',
      'Missed to fail for Human Intervention',
      'Incorrect Fail for Human Intervention',
      'Missed to fail for Poor Quality',
      'Incorrect fail for Poor Quality',
      'Missed to Edit the Sales Package',
      'Missed to Fail for Sales Package',
      'Incorrect fail for Sales Package',
      'Missed to fail for Assorted/Customized',
      'Incorrect fail for Assorted/Customized',
      'Missed to fail for Blur Image',
      'Incorrect fail for Blur Image',
      'Missed to fail for Partial Image',
      'Incorrect fail for Partial Image',
      'Missed to fail for Number of Content',
      'Incorrect fail for Number of Content',
      'Missed to fail for Pack of',
      'Incorrect fail for Pack of',
      'Missed to fail for Set Content',
      'Incorrect fail for Set Content',
      'Missed to edit/fail for MRP',
      'Incorrect fail for MRP',
      'Missed to fail for Brand Repetition',
      'Incorrect fail for Brand Repetition',
      'Missed to fail for Mandatory Image',
      'Incorrect fail for Mandatory Image',
      'Missed to fail for Flat Shoot',
      'Incorrect fail for Flat Shoot',
      'Missed to fail for Hanger/Holder Image',
      'Incorrect fail for Hanger/Holder Image',
      'Missed to fail for Barefoot Model',
      'Incorrect fail for Barefoot Model',
      'Missed to fail for Vertical',
      'Incorrect fail for Vertical',
      'Missed to fail/edit for Sleeve',
      'Incorrect fail for Sleeve',
      'Missed to fail/edit for Neck Type',
      'Incorrect fail for Neck Type',
      'Missed to fail for Hooded Attribute',
      'Incorrect fail for Hooded Attribute',
      'Missed to delete/fail Size Chart',
      'Incorrect fail for Size Chart',
      'Missed to fail for Head Cut',
      'Incorrect fail for Head Cut',
      'Missed to fail for Mannequin',
      'Incorrect fail for Mannequin',
      'Missed to fail for Multiple View',
      'Incorrect fail for Multiple View',
      'Missed to fail for Studio Type Attribute',
      'Missed to fail for Bottom Cut Top View',
      'Missed to fail for Top Cut Bottom View',
      'Missed to fail for Length Type',
      'Incorrect fail for Length Type',
      'Missed to fail/edit for Type Attribute',
      'Incorrect fail for Type Attribute',
      'Missed to fail for Warranty Summary',
      'Missed to fail for Border Image',
      'Incorrect fail for Border Image',
      'Missed to Delete the Image',
      'Missed to Click Image',
      'Missed to Click Attribute',
      'Incorrect Comment',
      'Missed to Add/Write Comment',
      'Missed to fail for Number of Containers',
      'Missed to fail for Number of T-shirts',
      'Missed to fail for Number of Keychains',
      'Missed to fail for Desgin for Attribute',
      'Incorrect fail for Desgin for Attribute',
      'Missed to fail for Ideal for',
      'Incorrect fail for Ideal for',
      'Missed to fail for Sw Product',
      'Incorrect fail for Sw Product',
      'Missed to fail for False Claim',
      'Incorrect fail for False Claim',
      'Missed to fail for Profanity',
      'Incorrect fail for Profanity',
      'Missed to fail for Ayush Lic',
      'Incorrect fail for Ayush Lic',
      'Missed to fail for BCCI Logo',
      'Missed to fail for Images Hurting Religious Sentiments',
      'Missed to fail for Pop Socket',
      'Missed to fail for National Flag/Emblem',
      'Missed to fail for Ashokha Chakra/Stambha',
      'Incorrect Vertical Selection',
      'Missed to fail for IPL Logo',
      'Missed to fail for ISBN Mismatch',
      'Incorrect fail for ISBN Mismatch',
      'Missed to fail for Publisher',
      'Incorrect fail for Publisher',
      'Missed to fail for Veg/Non-Veg Logo',
      'Incorrect fail for Veg/Non-Veg Logo',
      'Missed to fail for FSSAI Logo',
      'Incorrect fail for FSSAI Logo',
      'Missed to fail for Nutritional Content',
      'Incorrect fail for Nutritional Content',
      'Missed to fail for Occasion',
      'Incorrect fail for Occasion',
      'Missed to fail for Quantity',
      'Incorrect fail for Quantity',
      'Missed to fail for Number of Sets',
      'Incorrect fail for Number of Sets',
      'Missed to fail for Dial Shape',
      'Missed to fail for Packaging',
      'Missed to fail for Morphed Image',
      'Incorrect GID Usage',
      'Incorrect Failure',
      'Missed to fail for Explicit Content',
      'Incorrect fail for Explicit Content',
      'Missed to fail for Legal',
      'Incorrect fail for Legal',
      'Others',
      'Difference in Other Content',
      'Difference in Position',
      'Difference in Orientation',
      'Difference in Brand Content',
      'Difference in Size',
      'Difference in Resolution',
      'Difference in Image Edit'
    ]
  };

  const config = globalConfig && globalConfig.errorTypes && globalConfig.errorTypes.length > 0 ? globalConfig : fallbackConfig;

  const [disputes, setDisputes] = useState<AuditRecord[]>([]);

  // Filter agents based on alignment
  const myAlignedAgents = alignments
    .filter(a => a.qaEmail.toLowerCase() === user.email.toLowerCase())
    .map(a => a.agentName);

  const uniqueAgents = Array.from(new Set(tasks.map(t => t.qvName))).sort();
  const filteredAgents = uniqueAgents.filter(a => 
    a.toLowerCase().includes(searchAgent.toLowerCase())
  );
  
  const displayedAgents = user.role === UserRole.QA 
    ? filteredAgents.filter(a => myAlignedAgents.includes(a))
    : filteredAgents;

  useEffect(() => {
    if (!user) return;
    const pending = auditLogs
      .filter(d => d.disputeStatus === DisputeStatus.PENDING)
      .filter(d => myAlignedAgents.includes(d.qvName) || d.qaId === user.uid);
    setDisputes(pending);
  }, [user, alignments, auditLogs]);

  // Timer Logic
  useEffect(() => {
    if (auditOpen && startTime) {
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsedTime(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [auditOpen, startTime]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h} h ${m} m ${s} s`;
  };

  const startAudit = (task: SamplingTask) => {
    setCurrentTask(task);
    setAuditOpen(true);
    setAuditStep(1);
    setStartTime(Date.now());
    setAuditData({
      compErrorCount: 0,
      mpqcErrorCount: 0,
      status: 'Correct',
      qaComment: '',
      rowNo: '',
      errorType: [],
      guideline: [],
      theme: [],
      isOnPip: false,
      quality: 100
    });
  };

  const updateQuality = (comp: number, mpqc: number) => {
    let maxAllowed = currentTask?.rows || 1;
    let safeComp = Math.max(0, comp);
    let safeMpqc = Math.max(0, mpqc);
    
    // Ensure sum doesn't exceed total rows
    if (safeComp + safeMpqc > maxAllowed) {
      toast.warning(`Total errors cannot exceed the row count (${maxAllowed})`);
      return;
    }

    const q = calculateQuality(safeComp, safeMpqc, maxAllowed);
    setAuditData(prev => ({ 
      ...prev, 
      compErrorCount: safeComp, 
      mpqcErrorCount: safeMpqc, 
      quality: q,
      status: (safeComp > 0 || safeMpqc > 0) ? 'Incorrect' : prev.status 
    }));
  };

  const handleAuditSubmit = async () => {
    if (!currentTask) return;
    if (auditData.status === 'Incorrect' && !auditData.qaComment) {
      toast.error('QA Comment is required for Incorrect status');
      return;
    }

    const audit: AuditRecord = {
      ...editingAudit,
      id: editingAudit ? editingAudit.id : `audit-${Date.now()}`,
      taskId: currentTask.taskId || '',
      qvName: currentTask.qvName || '',
      vertical: currentTask.vertical || 'General',
      sellerId: currentTask.sellerId || '',
      categoryGroup: currentTask.categoryGroup || '',
      auditUrl: currentTask.auditUrl || '',
      attributesEdited: currentTask.attributesEdited || 0,
      imageReshuffle: currentTask.imageReshuffle || false,
      rows: currentTask.rows || 1,
      rowsPassed: (currentTask.rows || 1) - (auditData.compErrorCount + auditData.mpqcErrorCount),
      rowsFailed: (auditData.compErrorCount + auditData.mpqcErrorCount),
      compErrorCount: auditData.compErrorCount,
      mpqcErrorCount: auditData.mpqcErrorCount,
      quality: auditData.quality,
      status: auditData.status,
      qaComment: auditData.qaComment || '',
      isOnPip: auditData.isOnPip || false,
      rowNo: auditData.rowNo || '',
      errorType: auditData.status === 'Incorrect' ? (auditData.errorType.join(', ') || 'None') : 'None', 
      guideline: auditData.status === 'Incorrect' ? (auditData.guideline.join(', ') || 'None') : 'N/A',
      theme: auditData.status === 'Incorrect' ? (auditData.theme.join(', ') || 'None') : 'N/A',
      qaId: user.uid || '',
      auditDate: editingAudit ? editingAudit.auditDate : new Date().toISOString(),
      auditStartTime: editingAudit ? (editingAudit.auditStartTime || new Date().toISOString()) : (startTime ? new Date(startTime).toISOString() : new Date().toISOString()),
      disputeStatus: editingAudit ? editingAudit.disputeStatus : DisputeStatus.NONE,
      disputeHistory: editingAudit ? editingAudit.disputeHistory : [],
      agentId: currentTask.qvName || ''
    };

    try {
      if (editingAudit) {
        await updateDoc(doc(db, 'audits', audit.id), audit as any);
      } else {
        await setDoc(doc(db, 'audits', audit.id), audit);
        await updateDoc(doc(db, 'tasks', currentTask.id), { status: 'Completed' });
      }
      setAuditOpen(false);
      onCancelEdit?.();
      toast.success(editingAudit ? 'Audit Updated Successfully' : 'Audit Submitted Successfully');
    } catch (e: any) {
      toast.error('Failed to submit audit: ' + (e.message || String(e)));
      handleFirestoreError(e, editingAudit ? OperationType.UPDATE : OperationType.WRITE, `audits/${audit.id}`);
    }
  };

  const handleUpdateDispute = async (updated: AuditRecord) => {
    const docRef = doc(db, 'audits', updated.id);
    try {
      await updateDoc(docRef, {
        disputeStatus: updated.disputeStatus,
        disputeHistory: updated.disputeHistory,
        quality: updated.quality,
        status: updated.status
      });
      toast.success('Dispute resolved and closed.');
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `audits/${updated.id}`);
    }
  };

  const handleAIAnalyze = async () => {
    setAnalyzing(true);
    setAiTips([]);
    try {
      const tips = await analyzePrecision(auditLogs);
      setAiTips(tips);
      toast.success('AI Analysis complete!');
    } catch (e) {
      toast.error('Failed to analyze data.');
    } finally {
      setAnalyzing(false);
    }
  };

  if (activeTab === 'dashboard') {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold tracking-tight">QA Performance Insights</h2>
          <Button 
            disabled={analyzing}
            onClick={handleAIAnalyze}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white gap-2 shadow-lg"
          >
            {analyzing ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <Sparkles size={16} />}
            Analyze Auditing Precision
          </Button>
        </div>

        <AnimatePresence>
          {aiTips.length > 0 && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="mb-6">
              <Card className="bg-blue-50/50 border-blue-200">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-bold flex items-center gap-2 text-blue-700">
                     <BrainCircuit size={16} /> Gemini Insights
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid md:grid-cols-3 gap-4 pb-6">
                  {aiTips.map((tip, i) => (
                    <div key={i} className="bg-white p-3 rounded-lg border border-blue-100 flex gap-3 items-start shadow-sm">
                      <Lightbulb size={16} className="text-amber-500 shrink-0 mt-1" />
                      <p className="text-xs font-medium text-slate-700 leading-relaxed">{tip}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card 
            className="bg-white border-l-4 border-l-blue-600 cursor-pointer hover:bg-slate-50 transition-colors"
            onClick={() => goToTab?.('completed_audits')}
          >
            <CardHeader className="pb-2">
               <CardDescription className="text-xs uppercase font-semibold">Total Audits</CardDescription>
               <CardTitle className="text-2xl">{auditLogs.filter(a => a.qaId === user.uid).length}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-blue-600 font-medium">Click to view details</div>
            </CardContent>
          </Card>
          <Card className="bg-white border-l-4 border-l-green-600">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Avg. Quality</CardDescription>
              <CardTitle className="text-2xl">98.2%</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-green-600 font-medium">Above target (95%)</div>
            </CardContent>
          </Card>
          <Card className="bg-white border-l-4 border-l-amber-600">
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase font-semibold">Pending Review</CardDescription>
              <CardTitle className="text-2xl">{disputes.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-amber-600 font-medium">Disputes requiring action</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <History size={18} className="text-blue-600" />
              Recent Audit Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-12 text-slate-400">
              <p>No recent activity. Start auditing from the Audit Desk tab.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (activeTab === 'reports') {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-2xl font-bold tracking-tight text-[#0F172A]">Audit Performance Logs</h3>
            <p className="text-sm text-slate-500">Historical records of all audits performed by you today.</p>
          </div>
          <Button variant="outline" className="gap-2">
            <ExternalLink size={14} /> Export Sheet
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-slate-50/50">
                <TableRow>
                  <TableHead className="font-bold">Task ID</TableHead>
                  <TableHead className="font-bold">Agent Name</TableHead>
                  <TableHead className="font-bold text-center">Quality</TableHead>
                  <TableHead className="font-bold text-center">Status</TableHead>
                  <TableHead className="font-bold text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditLogs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-slate-400">
                      No audits performed in this session.
                    </TableCell>
                  </TableRow>
                ) : (
                  auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono font-bold text-blue-600">{log.taskId}</TableCell>
                      <TableCell className="font-medium text-[#0F172A]">{log.qvName}</TableCell>
                      <TableCell className="text-center">
                        <span className={`font-bold ${log.quality < 95 ? 'text-red-600' : 'text-green-600'}`}>
                          {log.quality}%
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge className={log.status === 'Correct' ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#FEE2E2] text-[#991B1B]'}>
                          {log.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-slate-500">
                        {new Date(log.auditDate).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (activeTab === 'sampling') {
    const pendingTasks = tasks.filter(t => t.status === 'Pending');
    const filteredTasks = selectedAgent 
      ? pendingTasks.filter(t => t.qvName === selectedAgent)
      : pendingTasks;

    // Grouping logic for the grid
    const groupedTasks: Record<number, SamplingTask[]> = {};
    filteredTasks.forEach(t => {
      if (!groupedTasks[t.rows]) groupedTasks[t.rows] = [];
      groupedTasks[t.rows].push(t);
    });

    return (
      <div className="flex h-[calc(100vh-140px)] bg-slate-50 rounded-xl overflow-hidden shadow-inner font-sans border border-slate-200">
        {/* Left Sidebar */}
        <div className="w-72 bg-white border-r border-slate-200 flex flex-col">
          <div className="p-6 border-b border-slate-100">
             <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Agent Alignment</h3>
             <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50 rounded-xl border border-slate-100 text-slate-400 focus-within:text-blue-600 focus-within:ring-2 focus-within:ring-blue-500/10 focus-within:border-blue-500 transition-all">
               <Search size={16} />
               <input 
                 className="bg-transparent border-none outline-none text-xs w-full text-slate-900 font-bold placeholder:text-slate-300" 
                 placeholder="Search Agent..." 
                 value={searchAgent}
                 onChange={(e) => setSearchAgent(e.target.value)}
               />
             </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
            <button 
              onClick={() => setSelectedAgent(null)}
              className={`w-full flex items-center justify-between p-4 rounded-xl transition-all duration-200 ${!selectedAgent ? 'bg-slate-900 text-white shadow-lg shadow-slate-900/10' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              <div className="flex items-center gap-3">
                <ClipboardCheck size={18} className={!selectedAgent ? 'text-blue-400' : 'text-slate-400'} />
                <span className="text-sm font-black">All Workload</span>
              </div>
              <Badge variant="secondary" className={`${!selectedAgent ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'} font-bold`}>{pendingTasks.length}</Badge>
            </button>
            <div className="h-px bg-slate-50 mx-4 my-2"></div>
            {displayedAgents.map(agent => (
              <button 
                key={agent}
                onClick={() => setSelectedAgent(agent)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl transition-all duration-200 group ${selectedAgent === agent ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <div className={`w-2 h-2 rounded-full ${selectedAgent === agent ? 'bg-white animate-pulse' : 'bg-slate-300 group-hover:bg-blue-400'}`}></div>
                <span className={`text-sm font-bold flex-1 truncate ${selectedAgent === agent ? 'text-white' : 'text-slate-700'}`}>
                  {agent}
                </span>
                {selectedAgent === agent && <ChevronRight size={14} className="text-white/50" />}
              </button>
            ))}
          </div>
        </div>

        {/* Right Workspace */}
        <div className="flex-1 bg-white flex flex-col overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
             <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
               QA Audit Workspace
             </h2>
             <div className="flex gap-4">
                <Badge className="bg-blue-600 font-bold px-3">Pending: {filteredTasks.length}</Badge>
             </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8 bg-[#F8FAFC]">
            {Object.keys(groupedTasks).sort((a,b) => Number(b)-Number(a)).map(rowKey => (
              <div key={rowKey} className="mb-12">
                <div className="flex items-center gap-4 mb-6">
                  <div className="h-1 w-12 bg-slate-900 rounded-full"></div>
                  <span className="text-3xl font-black text-slate-900 tracking-tighter">
                    {rowKey} <span className="text-sm font-bold text-slate-400 ml-2 uppercase tracking-normal">Rows</span>
                  </span>
                  <div className="flex-1 h-px bg-slate-100"></div>
                  <Badge variant="outline" className="text-slate-400 font-bold border-slate-200">
                    {groupedTasks[Number(rowKey)].length} Cases
                  </Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {groupedTasks[Number(rowKey)].map(task => (
                    <Card 
                      key={task.id} 
                      onClick={() => startAudit(task)}
                      className="group cursor-pointer hover:shadow-2xl transition-all border-slate-200 hover:border-blue-400 hover:-translate-y-1.5 bg-white overflow-hidden"
                    >
                      <div className="h-1 w-full bg-slate-100 group-hover:bg-blue-600 transition-colors"></div>
                      <CardContent className="p-5">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-1">{task.vertical || 'General'}</p>
                            <p className="font-inter font-extrabold text-slate-900 group-hover:text-blue-700 transition-colors truncate max-w-[140px]">
                              {task.qvName}
                            </p>
                          </div>
                          <Badge variant="outline" className="text-[9px] font-mono border-slate-100 bg-slate-50 text-slate-400">
                            {task.taskId.slice(-6)}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between mt-4">
                           <div className="flex -space-x-2">
                              <div className="w-5 h-5 rounded-full bg-slate-100 border border-white flex items-center justify-center text-[8px] font-bold text-slate-400">?</div>
                              <div className="w-5 h-5 rounded-full bg-blue-50 border border-white flex items-center justify-center text-[8px] font-bold text-blue-400">!</div>
                           </div>
                           <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] font-black text-blue-600 opacity-0 group-hover:opacity-100 transition-all gap-1">
                             AUDIT <ChevronRight size={10} />
                           </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
            
            {filteredTasks.length === 0 && (
              <div className="flex flex-col items-center justify-center py-32 text-slate-300">
                <ClipboardCheck size={64} strokeWidth={1} />
                <p className="mt-4 font-bold">No tasks to audit for this agent</p>
              </div>
            )}
          </div>
        </div>

        {/* AUDIT FORM DIALOG */}
        <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
          <DialogContent className="max-w-[95vw] md:max-w-6xl p-0 overflow-hidden border-none shadow-2xl">
            <div className="bg-white">
              {/* Header */}
              <div className="flex items-center justify-between p-6 border-b border-slate-100 bg-white">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
                    <ClipboardCheck size={20} />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-slate-900 tracking-tight">
                      {editingAudit ? 'Edit Audit Scoring' : 'Audit Workspace'}
                    </h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      {editingAudit ? `Scoring Adjustment for ${editingAudit.taskId}` : `Process: ${auditStep === 1 ? 'Data Verification' : 'Precision Scoring'}`}
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  {auditStep === 2 && (
                    <Button variant="ghost" size="sm" className="h-10 gap-2 font-bold text-slate-500 hover:text-slate-900" onClick={() => setAuditStep(1)}>
                      <ChevronLeft size={16} /> Data Details
                    </Button>
                  )}
                  <div className="w-px h-10 bg-slate-100 mx-2"></div>
                  {editingAudit && (
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-10 text-slate-400 hover:text-red-600 font-bold px-4" 
                      onClick={() => {
                        setAuditOpen(false);
                        onCancelEdit?.();
                      }}
                    >
                      Cancel Edit
                    </Button>
                  )}
                  {auditStep === 1 ? (
                    <div className="flex gap-2">
                       <Button variant="ghost" size="sm" className="h-10 text-slate-400 hover:text-red-600 font-bold px-4" onClick={async () => {
                         if (!currentTask) return;
                         await updateDoc(doc(db, 'tasks', currentTask.id), { status: 'Skipped' });
                         setAuditOpen(false);
                         toast.info('Task skipped');
                       }}>
                         <SkipForward size={16} className="mr-2" /> Skip
                       </Button>
                       <Button size="sm" className="h-10 bg-slate-900 hover:bg-black text-white gap-2 font-black px-6 rounded-lg shadow-lg shadow-slate-900/10" onClick={() => setAuditStep(2)}>
                         Start Scoring <ArrowRight size={16} />
                       </Button>
                    </div>
                  ) : (
                    <Button size="sm" className="h-10 bg-blue-600 hover:bg-blue-700 text-white gap-2 font-black px-8 rounded-lg shadow-xl shadow-blue-600/20" onClick={handleAuditSubmit}>
                      Submit Record
                    </Button>
                  )}
                </div>
              </div>

              {/* Step 1: Task Details */}
              {auditStep === 1 && currentTask && (
                <div className="p-8 max-h-[75vh] overflow-y-auto custom-scrollbar">
                  <div className="max-w-4xl mx-auto">
                    <div className="flex items-center gap-3 mb-8">
                      <div className="h-px flex-1 bg-slate-100"></div>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-4">Metadata Verification</span>
                      <div className="h-px flex-1 bg-slate-100"></div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-x-12 gap-y-8">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Agent Details</Label>
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                          <p className="text-xs font-bold text-slate-400 mb-1">QV Name</p>
                          <p className="text-sm font-black text-slate-900 break-all">{currentTask.qvName}</p>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Reference</Label>
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                          <p className="text-xs font-bold text-slate-400 mb-1">Task ID</p>
                          <p className="text-sm font-mono font-black text-blue-600 break-all">{currentTask.taskId}</p>
                        </div>
                      </div>
                      
                      <div className="col-span-2 space-y-1.5">
                        <Label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Work Item Link</Label>
                        <div className="p-4 bg-blue-50/50 rounded-xl border border-blue-100 flex items-center justify-between group">
                          <div className="overflow-hidden">
                            <p className="text-xs font-bold text-blue-400 mb-1">Audit URL</p>
                            <p className="text-[10px] font-mono text-blue-800 break-all">{currentTask.auditUrl || 'https://nemo.flipkart.net/task/' + currentTask.taskId}</p>
                          </div>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-10 w-10 p-0 text-blue-600 hover:bg-blue-100 shrink-0"
                            onClick={() => window.open(currentTask.auditUrl || ('https://nemo.flipkart.net/task/' + currentTask.taskId), '_blank')}
                          >
                            <ExternalLink size={18} />
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Context</Label>
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Vertical</p>
                            <p className="text-xs font-bold text-slate-900">{currentTask.vertical}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Seller ID</p>
                            <p className="text-xs font-bold text-slate-900 break-all">{currentTask.sellerId}</p>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Volume</Label>
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Total Rows</p>
                            <p className="text-sm font-black text-slate-900">{currentTask.rows}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Category</p>
                            <p className="text-xs font-bold text-slate-900 truncate">{currentTask.categoryGroup}</p>
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2 p-5 rounded-2xl bg-amber-50 border border-amber-100 flex items-center gap-5 shadow-sm">
                         <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600 shrink-0">
                           <ShieldAlert size={24} />
                         </div>
                         <div>
                           <p className="text-sm font-black text-amber-900">Task Verification Required</p>
                           <p className="text-[11px] font-bold text-amber-700/70 leading-relaxed">
                             Please ensure the Audit URL contents match the Task ID metadata before proceeding to Step 2.
                           </p>
                         </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Quality Scoring */}
              {auditStep === 2 && currentTask && (
                <div className="p-8 max-h-[75vh] overflow-y-auto custom-scrollbar bg-slate-50/30">
                   <div className="max-w-3xl mx-auto space-y-10 pb-12">
                    <div className="flex items-center justify-between p-5 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div className="flex items-center gap-4">
                         <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center text-red-600 animate-pulse border border-red-100">
                           <Clock size={20} />
                         </div>
                         <div className="flex flex-col">
                           <span className="text-xs font-black text-slate-900 leading-none">Live Audit Timer</span>
                           <span className="text-[10px] font-bold text-slate-400 mt-1.5 uppercase tracking-widest">{formatTime(elapsedTime)}</span>
                         </div>
                      </div>
                      <div className="flex flex-col items-end">
                         <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Task</span>
                         <span className="text-xs font-bold text-blue-600 font-mono">{currentTask.taskId}</span>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-8">
                       <div className="space-y-4">
                         <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Compliance Errors</Label>
                         <div className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl shadow-sm group hover:border-blue-200 transition-all">
                            <button 
                              onClick={() => updateQuality(auditData.compErrorCount - 1, auditData.mpqcErrorCount)}
                              className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                            >
                              <Minus size={24} />
                            </button>
                            <div className="flex flex-col items-center">
                              <input 
                                type="number" 
                                className="w-16 text-center text-4xl font-black text-slate-900 bg-transparent outline-none border-none hide-number-arrows"
                                value={auditData.compErrorCount === 0 && auditData.status !== 'Incorrect' ? '0' : auditData.compErrorCount}
                                onChange={(e) => updateQuality(parseInt(e.target.value) || 0, auditData.mpqcErrorCount)}
                              />
                              <span className="text-[9px] font-bold text-slate-400 uppercase">Errors</span>
                            </div>
                            <button 
                              onClick={() => updateQuality(auditData.compErrorCount + 1, auditData.mpqcErrorCount)}
                              className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 hover:bg-green-50 hover:text-green-500 transition-colors"
                            >
                              <Plus size={24} />
                            </button>
                         </div>
                       </div>

                       <div className="space-y-4">
                         <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">MPQC Errors</Label>
                         <div className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl shadow-sm group hover:border-blue-200 transition-all">
                            <button 
                              onClick={() => updateQuality(auditData.compErrorCount, auditData.mpqcErrorCount - 1)}
                              className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                            >
                              <Minus size={24} />
                            </button>
                            <div className="flex flex-col items-center">
                              <input 
                                type="number" 
                                className="w-16 text-center text-4xl font-black text-slate-900 bg-transparent outline-none border-none hide-number-arrows"
                                value={auditData.mpqcErrorCount === 0 && auditData.status !== 'Incorrect' ? '0' : auditData.mpqcErrorCount}
                                onChange={(e) => updateQuality(auditData.compErrorCount, parseInt(e.target.value) || 0)}
                              />
                              <span className="text-[9px] font-bold text-slate-400 uppercase">Errors</span>
                            </div>
                            <button 
                              onClick={() => updateQuality(auditData.compErrorCount, auditData.mpqcErrorCount + 1)}
                              className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 hover:bg-green-50 hover:text-green-500 transition-colors"
                            >
                              <Plus size={24} />
                            </button>
                         </div>
                       </div>
                    </div>

                    <div className="space-y-4">
                       <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Final QC Decision</Label>
                       <div className="grid grid-cols-3 gap-3 p-2 bg-slate-100 rounded-2xl">
                          {['Correct', 'Incorrect', 'Tech Issue'].map((status) => (
                            <button 
                             key={status}
                             onClick={() => setAuditData(prev => ({ ...prev, status: status as any }))}
                             className={`py-3.5 rounded-xl font-black text-xs tracking-wider uppercase transition-all shadow-sm ${auditData.status === status ? 'bg-blue-600 text-white ring-4 ring-blue-600/10' : 'bg-white text-slate-400 hover:text-slate-600'}`}
                            >
                              {status}
                            </button>
                          ))}
                       </div>
                    </div>

                    <AnimatePresence>
                      {auditData.status === 'Incorrect' && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-8 overflow-visible"
                        >
                          <div className="h-px bg-slate-100 w-full mt-4"></div>
                          <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                            <div className="space-y-2">
                              <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error Row No.*</Label>
                              <Input 
                                type="text"
                                placeholder="Enter row numbers (e.g., 2, 4-6, 12)"
                                className="h-12 rounded-xl border-slate-200 focus:ring-4 focus:ring-blue-500/10 font-bold"
                                value={auditData.rowNo}
                                onChange={(e) => setAuditData(prev => ({ ...prev, rowNo: e.target.value }))}
                              />
                            </div>
                            <div className="space-y-3">
                              <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error Type* (Multi-select)</Label>
                              <MultiSelectDropdown 
                                options={config.errorTypes}
                                selectedValues={auditData.errorType}
                                onToggle={(val) => toggleSelection('errorType', val)}
                                placeholder="Select Error Types"
                              />
                            </div>
                            <div className="space-y-3">
                              <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error Guideline* (Multi-select)</Label>
                              <MultiSelectDropdown 
                                options={config.guidelines}
                                selectedValues={auditData.guideline}
                                onToggle={(val) => toggleSelection('guideline', val)}
                                placeholder="Select Guidelines"
                              />
                            </div>
                            <div className="space-y-3">
                              <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error Theme* (Multi-select)</Label>
                              <MultiSelectDropdown 
                                options={config.themes}
                                selectedValues={auditData.theme}
                                onToggle={(val) => toggleSelection('theme', val)}
                                placeholder="Select Themes"
                              />
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="grid grid-cols-2 gap-8">
                       <div className="space-y-4">
                         <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Quality Score</Label>
                         <div className="p-5 bg-slate-900 rounded-2xl flex items-center justify-between border border-slate-800 shadow-xl">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">PRECISION %</span>
                            <span className={`text-3xl font-black ${auditData.quality < 95 ? 'text-red-400' : 'text-green-400'}`}>
                              {auditData.quality.toFixed(1)}%
                            </span>
                         </div>
                       </div>

                       <div className="space-y-4">
                         <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Performance Track</Label>
                         <button 
                           onClick={() => setAuditData(prev => ({ ...prev, isOnPip: !prev.isOnPip }))}
                           className={`w-full h-16 rounded-2xl flex items-center justify-center font-black text-xs tracking-widest uppercase transition-all shadow-md ${auditData.isOnPip ? 'bg-red-600 text-white shadow-red-600/20 ring-4 ring-red-600/10' : 'bg-white text-slate-400 border border-slate-200 hover:bg-slate-50'}`}
                         >
                           {auditData.isOnPip ? 'Is On PIP: YES' : 'Is On PIP: NO'}
                         </button>
                       </div>
                    </div>

                    <div className="space-y-4">
                       <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Detailed Observations</Label>
                       <textarea 
                        className="w-full h-32 p-5 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none text-sm font-bold text-slate-900 bg-white shadow-inner placeholder:text-slate-300 transition-all resize-none"
                        placeholder="Provide reasoning for incorrect status or technical issues..."
                        value={auditData.qaComment}
                        onChange={(e) => setAuditData(prev => ({ ...prev, qaComment: e.target.value }))}
                       />
                    </div>
                   </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-64 text-slate-400">
      <p>Module {activeTab} coming soon...</p>
    </div>
  );
}
