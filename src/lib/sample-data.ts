import { UserRole, UserProfile } from '../types';

export const MOCK_USER: UserProfile = {
  uid: 'admin-123',
  email: 'admin@precision360.com',
  name: 'Admin User',
  fullName: 'Admin User',
  role: UserRole.ADMIN,
  status: 'Active',
  department: 'Operations',
  Manager: 'System Root',
  createdAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString()
};

export const MOCK_CONFIG = {
  errorTypes: ['Critical', 'Major', 'Minor', 'Process'],
  guidelines: ['G1: Product Identity', 'G2: Image Quality', 'G3: Attribute Accuracy'],
  themes: ['Wrong Category', 'Low Res Image', 'Incorrect Brand', 'Missing Attribute'],
  skipLimit: 3,
  minSamplingCount: 1,
  systemOverrideRights: true
};

export const INITIAL_ALIGNMENTS = [
  { qaEmail: 'akshit.sodhi@bergtechnologies.co.in', agentName: 'aaryan.gurung@bergtechnologies.co.in' },
  { qaEmail: 'akshiya.dhiman@bergtechnologies.co.in', agentName: 'aatish.gupta@berg.co.in' },
  { qaEmail: 'kartikay.vasudev@bergtechnologies.co.in', agentName: 'abhi.changotra@bergtechnologies.co.in' },
  { qaEmail: 'akshit.sodhi@bergtechnologies.co.in', agentName: 'abhinav.bisht@berg.co.in' },
  { qaEmail: 'kartikay.vasudev@bergtechnologies.co.in', agentName: 'abhishek.kumar@berg.co.in' },
  { qaEmail: 'satyen.vaishnavi@bergtechnologies.co.in', agentName: 'abhishek.singh@berg.co.in' },
  { qaEmail: 'abhi.sharma@bergtechnologies.co.in', agentName: 'abhyank.rawat@berg.co.in' },
  { qaEmail: 'sandhya.pal@bergtechnologies.co.in', agentName: 'aditi.pharasi@berg.co.in' },
  { qaEmail: 'sahil.thakur@bergtechnologies.co.in', agentName: 'aditya.chetri@berg.co.in' },
  { qaEmail: 'akshiya.dhiman@bergtechnologies.co.in', agentName: 'aditya.kakar@berg.co.in' }
];

export const MOCK_QA_USER: UserProfile = {
  uid: 'qa-1',
  email: 'akshit.sodhi@bergtechnologies.co.in',
  name: 'Akshit Sodhi',
  fullName: 'Akshit Sodhi',
  role: UserRole.QA,
  status: 'Active',
  department: 'Operations',
  Manager: 'Sandhya Pal',
  createdAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString()
};
