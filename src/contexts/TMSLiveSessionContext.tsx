import React, { createContext, useContext, ReactNode } from 'react';
import { useLiveShifts } from '../components/tms/useLiveShifts';
import { TMSShift } from '../views/TMSView';

interface TMSLiveSessionContextValue {
  liveShifts: TMSShift[];
  activeShifts: TMSShift[];
  isLoading: boolean;
  error: Error | null;
  fetchLiveShifts: (isUserTriggered?: boolean) => Promise<TMSShift[]>;
  lastUpdated: number | null;
}

const TMSLiveSessionContext = createContext<TMSLiveSessionContextValue | null>(null);

interface TMSLiveSessionProviderProps {
  children: ReactNode;
  uid?: string;
  role?: string;
  authorizedTeamMemberUids?: string[];
  monitorAll?: boolean;
  isGlobalOverride?: boolean;
}

export const TMSLiveSessionProvider: React.FC<TMSLiveSessionProviderProps> = ({
  children,
  uid,
  role,
  authorizedTeamMemberUids,
  monitorAll = false,
  isGlobalOverride = false,
}) => {
  const { shifts, loading, error, fetchLiveShifts, lastUpdated } = useLiveShifts(
    uid,
    role,
    authorizedTeamMemberUids,
    monitorAll,
    isGlobalOverride
  );

  const activeShifts = shifts.filter(s => s.status === 'ACTIVE' || s.status === 'BREAK');

  return (
    <TMSLiveSessionContext.Provider
      value={{
        liveShifts: shifts,
        activeShifts,
        isLoading: loading,
        error,
        fetchLiveShifts,
        lastUpdated,
      }}
    >
      {children}
    </TMSLiveSessionContext.Provider>
  );
};

export const useTMSLiveSessions = (): TMSLiveSessionContextValue => {
  const context = useContext(TMSLiveSessionContext);
  if (!context) {
    return {
      liveShifts: [],
      activeShifts: [],
      isLoading: false,
      error: null,
      fetchLiveShifts: async () => [],
      lastUpdated: null,
    };
  }
  return context;
};
