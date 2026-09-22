import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type PropsWithChildren } from 'react';

import { api, clearCsrfToken, setCsrfToken } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const response = await api<{ user: User; csrfToken: string }>('/api/v1/auth/me');
      setCsrfToken(response.csrfToken);
      return response.user;
    },
    retry: false,
    staleTime: 60_000,
  });

  return (
    <AuthContext.Provider
      value={{
        user: session.data ?? null,
        loading: session.isLoading,
        refresh: async () => {
          await session.refetch();
        },
        logout: async () => {
          await api('/api/v1/auth/logout', { method: 'POST' });
          clearCsrfToken();
          queryClient.clear();
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error('AuthProvider is missing.');
  return state;
}

