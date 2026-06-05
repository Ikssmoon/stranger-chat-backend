# Project Brief — Anonymous Stranger Chat (MVP)

## Summary
A web-based, account-free stranger chat app. A user sets a quick filter (who they
are / who they want to talk to), enters a queue, gets matched with a compatible
stranger, and has a one-time text conversation they can leave or skip at any time.
No login, no message history, no media in v1.

The reference competitor is Vinme.ge. The goal of the MVP is a working web product,
not a polished launch — text-only, single region, desktop + mobile browser.

---

## Tech Stack
- **Frontend:** React (web). Plain Vite + React is fine; no Next.js needed for MVP.
- **Backend:** Node.js + Socket.IO (TypeScript preferred).
- **State:** in-memory only. No database.
- **Hosting (later):** Vercel (frontend) + Railway (backend, always-on plan).
- **Repos:** keep frontend and backend separate (or a monorepo with two packages)
  so they deploy independently.

---

## Build Order (do NOT build all at once)

### Pass 1 — Backend in isolation
Build the Socket.IO server with the matchmaking queue and message relay only.
No real frontend yet. Verify it with two `wscat` connections or a single throwaway
HTML test page opened in two tabs. The two things that must be correct here:
- **No double-matching** under simultaneous joins (remove both users from the queue
  atomically before emitting `matched`).
- **Disconnect cleanup** — if a socket drops, its partner is notified and the room
  is destroyed.

### Pass 2 — Minimal functional frontend
A bare React app, no styling. Connect, set filter, search, match, send/receive text,
skip, leave. Prove the full loop end-to-end.

### Pass 3 — Apply the real designs
Bring in the actual screens (start, searching with rotating "Did you know", chat,
filter bar, top-bar controls) and the visual styling.

---

## Socket Message Contract

This is the agreement both client and server build against. Lock it before coding.

### Client → Server
| Event | Payload | Meaning |
|---|---|---|
| `set_filter` | `{ iAm: 'm'\|'f'\|'any', lookingFor: 'm'\|'f'\|'any', region?: string }` | Set/update matching preferences |
| `start_search` | — | Enter the queue |
| `send_message` | `{ text: string }` | Send a chat message to current partner |
| `skip` | — | Leave current chat, re-enter queue immediately |
| `block` | — | Report + block current partner, re-enter queue |
| `leave` | — | Disconnect from chat, return to idle (no requeue) |

### Server → Client
| Event | Payload | Meaning |
|---|---|---|
| `searching` | — | Confirmed in queue |
| `matched` | `{ roomId: string }` | Paired with a partner; chat is now active |
| `message` | `{ text: string }` | Incoming message from partner |
| `partner_left` | `{ reason: 'skip'\|'disconnect'\|'block' }` | Partner ended the chat |
| `error` | `{ code: string, message: string }` | Something went wrong |

Keep payloads minimal. Add new event types later for post-MVP features rather than
overloading existing ones.

---

## User State Machine
```
idle ──start_search──> searching ──matched──> chatting
  ^                        |                     |
  |                        |                     ├─ skip / block ──> searching
  └──────── leave ─────────┴─────────────────────┤
                                                  └─ partner_left ──> searching*
```
\* On `partner_left`, the surviving user should be put back into searching
automatically (or shown a "find next" prompt — decide which).

---

## Matchmaking Logic
A valid match requires **mutual compatibility**: my `lookingFor` matches the
partner's `iAm`, AND the partner's `lookingFor` matches my `iAm`. `any` matches
anything. When a user enters the queue, look for the longest-waiting compatible
user, remove both atomically, create a room, emit `matched` to both.

`block` keeps a per-session list of blocked partner IDs (by socket/session id, since
there are no accounts) and excludes them from future matches in that session.

`region` (post-MVP) is just an extra bucket key alongside gender.

---

## Screens & States
1. **Start** — filter bar (I am / Looking for), centered prompt, "Let's start" button.
2. **Searching** — rotating "Did you know" facts (change every few seconds), a
   "Searching…" status pill. Top-bar actions disabled except filter.
3. **Chat** — message list, text input ("Type shit…"), active top-bar controls.
4. **Top bar** — Filter | Find Next | Block | Leave.

Top-bar controls are disabled on Start and Searching screens (filter stays enabled).

---

## Key Edge Cases (the part that actually takes time)
- Partner's socket drops mid-chat → emit `partner_left { reason: 'disconnect' }`,
  destroy the room, requeue the survivor if appropriate.
- Both users `skip` at the same instant → handle gracefully, no orphaned rooms.
- User closes the tab while searching → remove them from the queue.
- For MVP, a dropped connection ends the session — no reconnect/resume.
- Rate-limit `start_search` / `skip` so a user can't thrash the queue.

---

## Explicitly Out of Scope (v1)
Accounts/login, image or file sharing, video/voice, message history, native mobile
apps, monetization/ads, reconnect-resume.

---

## Post-MVP (build on the same socket, new event types only)
- **Minigames** — tic-tac-toe (easy), chess (use chess.js), drawing/guess.
  Add `game_move` style events; backend relays moves like chat.
- **Image sharing with mutual consent** — request/accept handshake before images
  unlock for the session; run images through Google Vision/Rekognition as a safety net.
- **BRB countdown** — one `brb { duration }` event; countdown runs client-side on both ends.
- **Social link exchange** — detect known profile-link patterns, hide the link, offer
  a mutual simultaneous reveal (both must agree before either sees the other's).
- **Region rooms** — `myapp.co/ge` etc. as an extra queue bucket; launch GE first, open global later.
