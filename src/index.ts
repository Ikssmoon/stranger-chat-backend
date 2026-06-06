import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { enqueue, dequeue } from './matchmaking';
import {
  UserSession, UserFilter, QueueEntry,
  ErrorPayload, PartnerLeftPayload,
} from './types';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const RATE_LIMIT_MS = 1000;
const MAX_MESSAGE_LENGTH = 2000;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// socketId → session
const sessions = new Map<string, UserSession>();
// roomId → { socketA, socketB }
const rooms = new Map<string, { socketA: string; socketB: string }>();

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
  rooms.set(roomId, { socketA, socketB });

  const sA = sessions.get(socketA);
  const sB = sessions.get(socketB);

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
  };

  const match = enqueue(entry);

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

// ─── connection handler ───────────────────────────────────────────────────────

function broadcastCount(): void {
  io.emit('connected_count', { count: io.engine.clientsCount });
}

io.on('connection', (socket: Socket) => {
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
    const replyTo = typeof data?.replyTo === 'string' ? data.replyTo.slice(0, MAX_MESSAGE_LENGTH) : '';

    const partner = partnerId(socket.id);
    if (partner) io.to(partner).emit('message', { text, id, replyTo });
  });

  // ── react ────────────────────────────────────────────────────────────────────
  socket.on('react', (data: { messageId: string; emoji: string | null }) => {
    const partner = partnerId(socket.id);
    if (partner) io.to(partner).emit('partner_reacted', { messageId: data.messageId, emoji: data.emoji });
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

    const clearedPartner = leaveRoom(socket.id);
    if (clearedPartner) notifyPartnerLeft(clearedPartner, 'block');
    enterQueue(socket);
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
      const partner = leaveRoom(socket.id);
      // `leave` reason re-uses 'disconnect' — partner just knows the user left
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
      const partner = leaveRoom(socket.id);
      if (partner) notifyPartnerLeft(partner, 'disconnect');
    }

    sessions.delete(socket.id);
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
