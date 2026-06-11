export type Gender = 'm' | 'f' | 'any';

export interface UserFilter {
  iAm: Gender;
  lookingFor: Gender;
  region?: string;
}

export interface QueueEntry {
  socketId: string;
  filter: UserFilter;
  joinedAt: number;
  blockedIds: Set<string>;
  ip: string;
}

export type UserState = 'idle' | 'searching' | 'chatting';

export interface UserSession {
  state: UserState;
  filter: UserFilter;
  roomId?: string;
  partnerId?: string;
  blockedIds: Set<string>;
  lastSearchAt: number;
  lastSkipAt: number;
  lastPongAt?: number;
  visitorId?: string;
  isReturning?: boolean;
}

// Server → Client event payloads
export interface MatchedPayload { roomId: string }
export interface MessagePayload { text: string }
export interface PartnerLeftPayload { reason: 'skip' | 'disconnect' | 'block' }
export interface ErrorPayload { code: string; message: string }
