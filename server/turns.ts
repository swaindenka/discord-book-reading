/**
 * Pure reading-turn logic. Kept free of I/O so it is easy to test.
 *
 * - `queue` holds the people waiting to read, in order.
 * - `reader` is the person currently reading (never also in `queue`).
 */
export interface TurnState {
  queue: string[];
  reader: string | null;
  turnStartedAt: number | null;
}

export type Requeue = 'back' | 'front' | 'none';

export function isQueued(state: TurnState, userId: string) {
  return state.queue.includes(userId);
}

/** Adds a user to the end of the queue. Returns false if they are already queued or reading. */
export function enqueue(state: TurnState, userId: string): boolean {
  if (state.reader === userId || state.queue.includes(userId)) return false;
  state.queue.push(userId);
  return true;
}

export function dequeue(state: TurnState, userId: string): boolean {
  const index = state.queue.indexOf(userId);
  if (index < 0) return false;
  state.queue.splice(index, 1);
  return true;
}

/** Moves a queued user to `index` (clamped). */
export function moveInQueue(state: TurnState, userId: string, index: number): boolean {
  const from = state.queue.indexOf(userId);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(state.queue.length - 1, Math.floor(index)));
  if (from === to) return false;
  state.queue.splice(from, 1);
  state.queue.splice(to, 0, userId);
  return true;
}

export function shuffleQueue(state: TurnState, random: () => number = Math.random) {
  const q = state.queue;
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
}

/** Ends the current turn and returns who was reading. */
export function endTurn(state: TurnState, requeue: Requeue): string | null {
  const previous = state.reader;
  state.reader = null;
  state.turnStartedAt = null;
  if (previous && !state.queue.includes(previous)) {
    if (requeue === 'back') state.queue.push(previous);
    else if (requeue === 'front') state.queue.unshift(previous);
  }
  return previous;
}

/**
 * Gives the turn to the first online person in the queue (skipping `exclude`).
 * Offline people keep their place in line. Returns the new reader, if any.
 */
export function startNext(
  state: TurnState,
  isOnline: (userId: string) => boolean,
  now: number,
  exclude: string | null = null,
): string | null {
  if (state.reader) return state.reader;
  const index = state.queue.findIndex((id) => id !== exclude && isOnline(id));
  if (index < 0) return null;
  const [next] = state.queue.splice(index, 1);
  state.reader = next;
  state.turnStartedAt = now;
  return next;
}

/**
 * Finishes/passes/skips the current turn and hands it to the next online person.
 * With `rotate`, the previous reader goes to the back of the line.
 * The previous reader is never handed the turn straight back.
 */
export function advance(
  state: TurnState,
  opts: { rotate: boolean; isOnline: (userId: string) => boolean; now: number },
): { previous: string | null; next: string | null } {
  const previous = endTurn(state, opts.rotate ? 'back' : 'none');
  const next = startNext(state, opts.isOnline, opts.now, previous);
  return { previous, next };
}

/** Makes `userId` the reader right away (moderator action). */
export function setReader(state: TurnState, userId: string, opts: { rotate: boolean; now: number }) {
  if (state.reader === userId) return { previous: null as string | null };
  const previous = endTurn(state, opts.rotate ? 'back' : 'none');
  dequeue(state, userId);
  state.reader = userId;
  state.turnStartedAt = opts.now;
  return { previous };
}

/** Removes a user from the queue and, if they were reading, ends their turn. */
export function removeUser(
  state: TurnState,
  userId: string,
  opts: { isOnline: (userId: string) => boolean; now: number },
): { wasReader: boolean; next: string | null } {
  dequeue(state, userId);
  if (state.reader !== userId) return { wasReader: false, next: null };
  endTurn(state, 'none');
  return { wasReader: true, next: startNext(state, opts.isOnline, opts.now, userId) };
}
