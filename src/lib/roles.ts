import { UserRole } from '../types';

export const MANAGER_ROLES = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.OPS_HEAD,
  UserRole.HR,
  UserRole.IT_MANAGER,
  UserRole.TEAM_LEAD,
  UserRole.STL,
  UserRole.OPS_TL,
];

export const TL_ROLES = [
  UserRole.TEAM_LEAD,
  UserRole.STL,
  UserRole.QTL,
  UserRole.OPS_TL,
  UserRole.TRAINER_TL,
  UserRole.SME,
];

export const normalizeRole = (role: string | undefined): UserRole | null => {
  if (!role) return null;
  const normalized = role.toUpperCase().trim().replace(/ /g, '_');
  return (UserRole as any)[normalized] || null;
};

export const isManagerRole = (role: string | undefined) => {
  const normalized = normalizeRole(role);
  return normalized ? MANAGER_ROLES.includes(normalized) : false;
};

export const isTLRole = (role: string | undefined) => {
  const normalized = normalizeRole(role);
  return normalized ? TL_ROLES.includes(normalized) : false;
};
