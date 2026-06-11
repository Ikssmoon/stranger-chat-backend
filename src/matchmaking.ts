import { QueueEntry, UserFilter } from './types';

const queue: QueueEntry[] = [];

function isCompatible(
  aFilter: UserFilter, aId: string, aBlocked: Set<string>, aIp: string,
  bFilter: UserFilter, bId: string, bBlocked: Set<string>, bIp: string,
  blockedPairs: Set<string>,
): boolean {
  if (aBlocked.has(bId) || bBlocked.has(aId)) return false;

  if (aIp && bIp && (blockedPairs.has(`${aIp}:${bIp}`) || blockedPairs.has(`${bIp}:${aIp}`))) {
    console.log(`Matchmaking skip: ${aIp} and ${bIp} are blocked`);
    return false;
  }

  const aWantsB = aFilter.lookingFor === 'any' || aFilter.lookingFor === bFilter.iAm || bFilter.iAm === 'any';
  const bWantsA = bFilter.lookingFor === 'any' || bFilter.lookingFor === aFilter.iAm || aFilter.iAm === 'any';

  return aWantsB && bWantsA;
}

/**
 * Try to match `entry` against the existing queue.
 * If a match is found: removes the matched entry from the queue and returns it
 *   (the caller's entry is NOT added to the queue).
 * If no match: adds `entry` to the queue and returns null.
 *
 * Safe against double-matching because Node.js processes one event at a time —
 * no await between the find and splice.
 */
export function enqueue(entry: QueueEntry, blockedPairs: Set<string>): QueueEntry | null {
  const matchIndex = queue.findIndex(
    c => isCompatible(
      entry.filter, entry.socketId, entry.blockedIds, entry.ip,
      c.filter, c.socketId, c.blockedIds, c.ip,
      blockedPairs,
    ),
  );

  if (matchIndex !== -1) {
    const [match] = queue.splice(matchIndex, 1);
    return match;
  }

  queue.push(entry);
  return null;
}

export function dequeue(socketId: string): void {
  const idx = queue.findIndex(e => e.socketId === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

export function queueLength(): number {
  return queue.length;
}
