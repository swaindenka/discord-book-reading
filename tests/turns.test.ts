import { describe, expect, it } from 'vitest';
import * as turns from '../server/turns.js';

const state = (queue: string[], reader: string | null = null): turns.TurnState => ({
  queue: [...queue],
  reader,
  turnStartedAt: reader ? 1 : null,
});
const everyone = () => true;

describe('queue basics', () => {
  it('enqueues once per person and never queues the reader', () => {
    const s = state([], 'alice');
    expect(turns.enqueue(s, 'bob')).toBe(true);
    expect(turns.enqueue(s, 'bob')).toBe(false);
    expect(turns.enqueue(s, 'alice')).toBe(false);
    expect(s.queue).toEqual(['bob']);
  });

  it('moves people within the queue with clamping', () => {
    const s = state(['a', 'b', 'c', 'd']);
    turns.moveInQueue(s, 'd', 0);
    expect(s.queue).toEqual(['d', 'a', 'b', 'c']);
    turns.moveInQueue(s, 'd', 99);
    expect(s.queue).toEqual(['a', 'b', 'c', 'd']);
    expect(turns.moveInQueue(s, 'zed', 0)).toBe(false);
  });

  it('shuffles without losing anyone', () => {
    const s = state(['a', 'b', 'c', 'd', 'e']);
    let seed = 0.3;
    turns.shuffleQueue(s, () => (seed = (seed * 9301 + 0.49297) % 1));
    expect([...s.queue].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('advancing turns', () => {
  it('rotates the finished reader to the back of the line', () => {
    const s = state(['bob', 'carol'], 'alice');
    const result = turns.advance(s, { rotate: true, isOnline: everyone, now: 5 });
    expect(result).toEqual({ previous: 'alice', next: 'bob' });
    expect(s).toMatchObject({ reader: 'bob', queue: ['carol', 'alice'], turnStartedAt: 5 });
  });

  it('drops the finished reader without rotation', () => {
    const s = state(['bob'], 'alice');
    turns.advance(s, { rotate: false, isOnline: everyone, now: 5 });
    expect(s).toMatchObject({ reader: 'bob', queue: [] });
  });

  it('skips offline people but keeps their place in line', () => {
    const s = state(['bob', 'carol'], 'alice');
    turns.advance(s, { rotate: true, isOnline: (id) => id !== 'bob', now: 5 });
    expect(s.reader).toBe('carol');
    expect(s.queue).toEqual(['bob', 'alice']);
  });

  it('never hands the turn straight back to the person who passed', () => {
    const s = state([], 'alice');
    const result = turns.advance(s, { rotate: true, isOnline: everyone, now: 5 });
    expect(result.next).toBeNull();
    expect(s.reader).toBeNull();
    expect(s.queue).toEqual(['alice']);
  });

  it('starts the first online person in line', () => {
    const s = state(['bob', 'carol']);
    expect(turns.startNext(s, (id) => id === 'carol', 9)).toBe('carol');
    expect(s.queue).toEqual(['bob']);
    expect(s.turnStartedAt).toBe(9);
  });

  it('lets a moderator hand the turn to someone', () => {
    const s = state(['bob', 'carol'], 'alice');
    turns.setReader(s, 'carol', { rotate: true, now: 3 });
    expect(s).toMatchObject({ reader: 'carol', queue: ['bob', 'alice'] });
  });

  it('pauses a turn by putting the reader first in line', () => {
    const s = state(['bob'], 'alice');
    expect(turns.endTurn(s, 'front')).toBe('alice');
    expect(s).toMatchObject({ reader: null, queue: ['alice', 'bob'] });
  });

  it('removes a kicked reader and moves on', () => {
    const s = state(['bob'], 'alice');
    expect(turns.removeUser(s, 'alice', { isOnline: everyone, now: 2 })).toEqual({ wasReader: true, next: 'bob' });
    expect(s).toMatchObject({ reader: 'bob', queue: [] });
  });
});
