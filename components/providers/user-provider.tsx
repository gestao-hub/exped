'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Profile } from '@/lib/types';

type UserContextValue = {
  profile: Profile;
};

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({
  profile,
  children,
}: {
  profile: Profile;
  children: ReactNode;
}) {
  return <UserContext.Provider value={{ profile }}>{children}</UserContext.Provider>;
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useUser deve ser usado dentro de <UserProvider>');
  }
  return ctx;
}
