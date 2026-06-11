import 'dotenv/config';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { enqueue, dequeue } from './matchmaking';
import {
  UserSession, UserFilter, QueueEntry,
  ErrorPayload, PartnerLeftPayload,
} from './types';
import { supabase } from './supabase';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const RATE_LIMIT_MS = 1000;
const MAX_MESSAGE_LENGTH = 2000;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// socketId → ip
const socketToIp = new Map<string, string>();
// "ipA:ipB" pairs that are mutually blocked (both directions stored)
const blockedPairs = new Set<string>();

// Load existing blocks from Supabase on startup
if (supabase) {
  void (async () => {
    try {
      const { data } = await supabase.from('blocks').select('blocker_ip, blocked_ip');
      if (data) {
        data.forEach(({ blocker_ip, blocked_ip }: { blocker_ip: string; blocked_ip: string }) => {
          blockedPairs.add(`${blocker_ip}:${blocked_ip}`);
          blockedPairs.add(`${blocked_ip}:${blocker_ip}`);
        });
        console.log(`Loaded ${data.length} block pairs from Supabase`);
      }
    } catch (err) {
      console.error('Failed to load block pairs:', err);
    }
  })();
}

// socketId → session
const sessions = new Map<string, UserSession>();
// roomId → Room
interface RoomLink { url: string; platform: string }
interface RoomAnalytics {
  startedAt: number;
  messageCount: number;
  linkExchanged: boolean;
  reactionsUsed: boolean;
  brbUsed: boolean;
  replyUsed: boolean;
  userAFilter: UserFilter;
  userBFilter: UserFilter;
  visitorIdA: string;
  visitorIdB: string;
  isReturningA: boolean;
  isReturningB: boolean;
}
interface Room {
  socketA: string;
  socketB: string;
  linkA?: RoomLink;
  linkB?: RoomLink;
  analytics: RoomAnalytics;
}
const rooms = new Map<string, Room>();

// ─── helpers ─────────────────────────────────────────────────────────────────

function session(socketId: string): UserSession | undefined {
  return sessions.get(socketId);
}

function partnerId(socketId: string): string | undefined {
  const s = sessions.get(socketId);
  if (!s?.roomId) return undefined;
  const room = rooms.get(s.roomId);
  if (!room) return undefined;
  return room.socketA === socketId ? room.socketB : room.socketA;
}

/**
 * Remove a room and reset both participants to idle.
 * Returns the partner's socket ID so the caller can notify and requeue them.
 */
function leaveRoom(socketId: string): string | undefined {
  const s = sessions.get(socketId);
  if (!s?.roomId) return undefined;

  const roomId = s.roomId;
  const room = rooms.get(roomId);
  const partner = room
    ? (room.socketA === socketId ? room.socketB : room.socketA)
    : undefined;

  s.roomId = undefined;
  s.partnerId = undefined;
  s.state = 'idle';
  rooms.delete(roomId);

  if (partner) {
    const ps = sessions.get(partner);
    if (ps) {
      ps.roomId = undefined;
      ps.partnerId = undefined;
      ps.state = 'idle';
    }
  }

  return partner;
}

/** Pair two sockets into a new room and emit `matched` to both. */
function createRoom(socketA: string, socketB: string): void {
  const roomId = uuidv4();
  const sA = sessions.get(socketA);
  const sB = sessions.get(socketB);

  rooms.set(roomId, {
    socketA,
    socketB,
    analytics: {
      startedAt: Date.now(),
      messageCount: 0,
      linkExchanged: false,
      reactionsUsed: false,
      brbUsed: false,
      replyUsed: false,
      userAFilter: sA ? { ...sA.filter } : { iAm: 'any', lookingFor: 'any' },
      userBFilter: sB ? { ...sB.filter } : { iAm: 'any', lookingFor: 'any' },
      visitorIdA: sA?.visitorId ?? '',
      visitorIdB: sB?.visitorId ?? '',
      isReturningA: sA?.isReturning ?? false,
      isReturningB: sB?.isReturning ?? false,
    },
  });

  if (sA) { sA.state = 'chatting'; sA.roomId = roomId; sA.partnerId = socketB; }
  if (sB) { sB.state = 'chatting'; sB.roomId = roomId; sB.partnerId = socketA; }

  io.to(socketA).emit('matched', { roomId });
  io.to(socketB).emit('matched', { roomId });
}

/** Enter the matchmaking queue. If a match exists, create a room immediately. */
function enterQueue(socket: Socket): void {
  const s = sessions.get(socket.id);
  if (!s) return;

  const entry: QueueEntry = {
    socketId: socket.id,
    filter: { ...s.filter },
    joinedAt: Date.now(),
    blockedIds: s.blockedIds,
    ip: socketToIp.get(socket.id) ?? '',
  };

  const match = enqueue(entry, blockedPairs);

  if (match) {
    createRoom(socket.id, match.socketId);
  } else {
    s.state = 'searching';
    socket.emit('searching');
  }
}

/** Notify a partner they were left. They will re-search manually via the bubble. */
function notifyPartnerLeft(toSocketId: string, reason: PartnerLeftPayload['reason']): void {
  io.to(toSocketId).emit('partner_left', { reason } satisfies PartnerLeftPayload);
}

function sendError(socket: Socket, code: string, message: string): void {
  socket.emit('error', { code, message } satisfies ErrorPayload);
}

async function upsertVisitor(visitorId: string, gender: string, now: Date): Promise<void> {
  if (!supabase || !visitorId) return;
  try {
    const { data } = await supabase.from('visitors').select('session_count').eq('id', visitorId).single();
    if (data) {
      await supabase.from('visitors').update({
        last_seen: now.toISOString(),
        session_count: (data.session_count || 0) + 1,
      }).eq('id', visitorId);
    } else {
      await supabase.from('visitors').insert({
        id: visitorId,
        first_seen: now.toISOString(),
        last_seen: now.toISOString(),
        session_count: 1,
        gender,
      });
    }
  } catch (err) { console.error('[analytics] visitor upsert failed:', err); }
}

function writeRoomAnalytics(roomId: string, endReason: string): void {
  if (!supabase) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const { analytics } = room;
  const now = new Date();
  const durationSeconds = Math.floor((Date.now() - analytics.startedAt) / 1000);
  void (async () => {
    try {
      await supabase.from('sessions').insert({
        id: roomId,
        created_at: new Date(analytics.startedAt).toISOString(),
        ended_at: now.toISOString(),
        duration_seconds: durationSeconds,
        end_reason: endReason,
        message_count: analytics.messageCount,
        user_a_filter: analytics.userAFilter,
        user_b_filter: analytics.userBFilter,
        link_exchanged: analytics.linkExchanged,
        reactions_used: analytics.reactionsUsed,
        brb_used: analytics.brbUsed,
        reply_used: analytics.replyUsed,
        visitor_id_a: analytics.visitorIdA,
        visitor_id_b: analytics.visitorIdB,
        is_returning_a: analytics.isReturningA,
        is_returning_b: analytics.isReturningB,
        meta: {},
      });
    } catch {}
  })();
  void upsertVisitor(analytics.visitorIdA, analytics.userAFilter.iAm, now);
  void upsertVisitor(analytics.visitorIdB, analytics.userBFilter.iAm, now);
}

// ─── connection handler ───────────────────────────────────────────────────────

function broadcastCount(): void {
  io.emit('connected_count', { count: io.engine.clientsCount });
}

io.on('connection', (socket: Socket) => {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const ip = ((Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim())
    ?? socket.handshake.address;
  socketToIp.set(socket.id, ip);

  sessions.set(socket.id, {
    state: 'idle',
    filter: { iAm: 'any', lookingFor: 'any' },
    blockedIds: new Set(),
    lastSearchAt: 0,
    lastSkipAt: 0,
  });

  broadcastCount();

  // ── set_filter ──────────────────────────────────────────────────────────────
  socket.on('set_filter', (data: Partial<UserFilter>) => {
    const s = session(socket.id);
    if (!s) return;

    const validGenders = new Set(['m', 'f', 'any']);
    if (data.iAm && validGenders.has(data.iAm)) s.filter.iAm = data.iAm;
    if (data.lookingFor && validGenders.has(data.lookingFor)) s.filter.lookingFor = data.lookingFor;
    if (typeof data.region === 'string') s.filter.region = data.region;
  });

  // ── start_search ────────────────────────────────────────────────────────────
  socket.on('start_search', () => {
    const s = session(socket.id);
    if (!s) return;

    if (s.state !== 'idle') {
      sendError(socket, 'INVALID_STATE', 'Must be idle to start searching');
      return;
    }
    const now = Date.now();
    if (now - s.lastSearchAt < RATE_LIMIT_MS) {
      sendError(socket, 'RATE_LIMITED', 'Too fast — wait a moment');
      return;
    }
    s.lastSearchAt = now;

    enterQueue(socket);
  });

  // ── send_message ────────────────────────────────────────────────────────────
  socket.on('send_message', (data: { text: string; id?: string; replyTo?: string }) => {
    const s = session(socket.id);
    if (!s || s.state !== 'chatting') {
      sendError(socket, 'NOT_IN_CHAT', 'Not in a chat');
      return;
    }
    if (typeof data?.text !== 'string' || data.text.trim() === '') return;
    const text = data.text.slice(0, MAX_MESSAGE_LENGTH);
    const id = typeof data?.id === 'string' ? data.id : uuidv4();
    const partner = partnerId(socket.id);
    if (partner) {
      io.to(partner).emit('message', { text, id, replyTo: data.replyTo || '' });
      if (s.roomId) {
        const room = rooms.get(s.roomId);
        if (room) {
          room.analytics.messageCount++;
          if (data.replyTo) room.analytics.replyUsed = true;
        }
      }
    }
  });

  // ── react ────────────────────────────────────────────────────────────────────
  socket.on('react', (data: { messageId: string; emoji: string | null }) => {
    const s = session(socket.id);
    const partner = partnerId(socket.id);
    if (partner) io.to(partner).emit('partner_reacted', { messageId: data.messageId, emoji: data.emoji });
    if (s?.roomId) {
      const room = rooms.get(s.roomId);
      if (room) room.analytics.reactionsUsed = true;
    }
  });

  // ── social_link ───────────────────────────────────────────────────────────────
  socket.on('social_link', (data: { platform: string; url: string }) => {
    const s = session(socket.id);
    if (!s?.roomId) return;
    const room = rooms.get(s.roomId);
    if (!room) return;

    const link: RoomLink = { url: data.url, platform: data.platform };
    const isA = room.socketA === socket.id;
    if (isA) room.linkA = link; else room.linkB = link;

    const partner = partnerId(socket.id);
    if (partner) io.to(partner).emit('social_request', { platform: data.platform });

    if (room.linkA && room.linkB) {
      room.analytics.linkExchanged = true;
      io.to(room.socketA).emit('social_reveal', { yourUrl: room.linkA.url, theirUrl: room.linkB.url });
      io.to(room.socketB).emit('social_reveal', { yourUrl: room.linkB.url, theirUrl: room.linkA.url });
      room.linkA = undefined;
      room.linkB = undefined;
    }
  });

  // ── skip ────────────────────────────────────────────────────────────────────
  socket.on('skip', () => {
    const s = session(socket.id);
    if (!s || s.state !== 'chatting') {
      sendError(socket, 'INVALID_STATE', 'Not in a chat');
      return;
    }
    const now = Date.now();
    if (now - s.lastSkipAt < RATE_LIMIT_MS) {
      sendError(socket, 'RATE_LIMITED', 'Too fast — wait a moment');
      return;
    }
    s.lastSkipAt = now;

    if (s.roomId) writeRoomAnalytics(s.roomId, 'skip');
    const partner = leaveRoom(socket.id);
    if (partner) notifyPartnerLeft(partner, 'skip');
    enterQueue(socket);
  });

  // ── block ───────────────────────────────────────────────────────────────────
  socket.on('block', () => {
    const s = session(socket.id);
    if (!s || s.state !== 'chatting') {
      sendError(socket, 'INVALID_STATE', 'Not in a chat');
      return;
    }

    const partner = partnerId(socket.id);
    if (partner) s.blockedIds.add(partner);

    const blockerIp = socketToIp.get(socket.id) ?? '';
    const blockedIp = partner ? (socketToIp.get(partner) ?? '') : '';
    if (blockerIp && blockedIp) {
      blockedPairs.add(`${blockerIp}:${blockedIp}`);
      blockedPairs.add(`${blockedIp}:${blockerIp}`);
      console.log(`Blocked: ${blockerIp} → ${blockedIp}`);
      if (supabase) {
        void (async () => {
          try {
            const { error } = await supabase.from('blocks').insert({
              blocker_ip: blockerIp,
              blocked_ip: blockedIp,
              created_at: new Date(),
            });
            if (error) console.error('[blocks] insert error:', error.message, error.code, error.details);
            else console.log(`[blocks] persisted: ${blockerIp} → ${blockedIp}`);
          } catch (err) {
            console.error('[blocks] insert exception:', err);
          }
        })();
      }
    }

    if (s.roomId) writeRoomAnalytics(s.roomId, 'block');
    const clearedPartner = leaveRoom(socket.id);
    if (clearedPartner) notifyPartnerLeft(clearedPartner, 'block');
    enterQueue(socket);
  });

  // ── identify ────────────────────────────────────────────────────────────────
  socket.on('identify', (data: { visitorId: string; isReturning: boolean }) => {
    const s = session(socket.id);
    if (!s) return;
    if (typeof data?.visitorId === 'string') s.visitorId = data.visitorId;
    if (typeof data?.isReturning === 'boolean') s.isReturning = data.isReturning;
  });

  // ── client_error ─────────────────────────────────────────────────────────────
  socket.on('client_error', (data: { message: string; stack: string; pageState: string; userAgent: string; visitorId: string }) => {
    if (!supabase) return;
    void (async () => {
      try {
        await supabase.from('client_errors').insert({
          id: uuidv4(),
          created_at: new Date().toISOString(),
          visitor_id: data.visitorId,
          error_message: data.message,
          error_stack: data.stack,
          page_state: data.pageState,
          user_agent: data.userAgent,
          meta: {},
        });
      } catch {}
    })();
  });

  // ── typing ──────────────────────────────────────────────────────────────────
  socket.on('typing', () => {
    const partner = partnerId(socket.id);
    if (partner) io.to(partner).emit('partner_typing');
  });

  // ── leave ───────────────────────────────────────────────────────────────────
  socket.on('leave', () => {
    const s = session(socket.id);
    if (!s) return;

    if (s.state === 'searching') {
      dequeue(socket.id);
      s.state = 'idle';
    } else if (s.state === 'chatting') {
      if (s.roomId) writeRoomAnalytics(s.roomId, 'leave');
      const partner = leaveRoom(socket.id);
      if (partner) notifyPartnerLeft(partner, 'disconnect');
    }
  });

  // ── disconnect ──────────────────────────────────────────────────────────────
  socket.on('pong_custom', () => {
    const s = session(socket.id);
    if (s) s.lastPongAt = Date.now();
  });

  socket.on('disconnect', () => {
    const s = session(socket.id);
    if (!s) return;

    if (s.state === 'searching') {
      dequeue(socket.id);
    } else if (s.state === 'chatting') {
      if (s.roomId) writeRoomAnalytics(s.roomId, 'disconnect');
      const partner = leaveRoom(socket.id);
      if (partner) notifyPartnerLeft(partner, 'disconnect');
    }

    sessions.delete(socket.id);
    socketToIp.delete(socket.id);
    broadcastCount();
  });
});

// ── heartbeat ────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL = 5000;

setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach(socket => {
    const s = sessions.get(socket.id);
    if (!s) return;

    // Check if socket responded to previous ping
    if (s.lastPongAt && now - s.lastPongAt > HEARTBEAT_INTERVAL * 2) {
      socket.disconnect(true);
      return;
    }

    // Send ping
    s.lastPongAt = 0;
    socket.emit('ping_custom');
  });
}, HEARTBEAT_INTERVAL);

httpServer.listen(PORT, () => {
  console.log(`stranger-chat backend listening on :${PORT}`);
});
