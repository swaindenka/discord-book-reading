import { useEffect, useState } from 'react';
import type { MemberInfo, MemberRole, PublicUser, RoomState } from '../../../shared/types';

export const RANK: Record<MemberRole, number> = { member: 1, mod: 2, owner: 3, admin: 4 };

export function roleOf(state: RoomState, user: PublicUser): MemberRole {
  if (user.isAdmin) return 'admin';
  if (state.ownerId === user.id) return 'owner';
  if (state.moderators.includes(user.id)) return 'mod';
  return 'member';
}

export interface RoomPerspective {
  me: PublicUser;
  role: MemberRole;
  isMod: boolean;
  isReader: boolean;
  queueIndex: number;
  /** First person in line who is online. */
  nextUp: MemberInfo | null;
}

export function perspective(state: RoomState, me: PublicUser): RoomPerspective {
  const role = roleOf(state, me);
  return {
    me,
    role,
    isMod: RANK[role] >= RANK.mod,
    isReader: state.reader?.id === me.id,
    queueIndex: state.queue.findIndex((m) => m.id === me.id),
    nextUp: state.queue.find((m) => m.online) ?? null,
  };
}

/** Re-renders every `ms` milliseconds. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
