import { UserRole } from '../types';

export const MANAGER_ROLES = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.OPS_HEAD,
  UserRole.HR,
  UserRole.IT_MANAGER,
  UserRole.TEAM_LEAD,
];

export const TL_ROLES = [
  UserRole.TEAM_LEAD,
  UserRole.SME,
];

export const normalizeRole = (role: string | undefined): UserRole | null => {
  if (!role) return null;
  const raw = role.toString().toUpperCase().trim().replace(/[\s\-_]+/g, '_');
  if (['STL', 'OPS_TL', 'QTL', 'TRAINER_TL', 'TEAM_LEAD', 'TEAM_LEADER', 'OPS_TEAM_LEAD', 'TRAINER_TEAM_LEAD'].includes(raw) || raw.endsWith('_TL')) {
    return UserRole.TEAM_LEAD;
  }
  return (UserRole as any)[raw] || null;
};

export const isManagerRole = (role: string | undefined) => {
  const normalized = normalizeRole(role);
  return normalized ? MANAGER_ROLES.includes(normalized) : false;
};

export const isTLRole = (role: string | undefined) => {
  const normalized = normalizeRole(role);
  return normalized ? TL_ROLES.includes(normalized) : false;
};
