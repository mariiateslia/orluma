import { createContext, useContext } from 'react';
import type { Route, User, Workspace, WorkspaceData } from './types';
export type AppContextValue = {
  user: User;
  data: WorkspaceData;
  workspaces: Workspace[];
  route: Route;
  admin: boolean;
  canEdit: boolean;
  go: (path: string) => void;
  refresh: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  logout: () => Promise<void>;
  newWorkspace: () => void;
  connection: 'connecting' | 'live' | 'reconnecting';
  setDirty: (dirty: boolean) => void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('Workspace context is missing.');
  return value;
}
