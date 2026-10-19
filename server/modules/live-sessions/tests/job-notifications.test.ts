import assert from 'node:assert/strict';
import test from 'node:test';

import { liveSessionsService } from '@/modules/live-sessions/index.js';
import { startJobNotifications } from '@/modules/live-sessions/services/job-notifications.service.js';

type Entry = { at?: string; state?: string; detail?: string; text?: string };

const job = (state: string, detail: string) => ({
  state, detail, name: 'Job', sessionId: 's-1', daemonShort: 'job00001', updatedAt: detail,
});
const agent = { pid: 1, id: 'job00001', kind: 'background', sessionId: 's-1', cwd: '/srv', status: 'idle', state: 'blocked' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Mirrors the real timeline: a turn that ends leaves its reply's text; a user
// message leaves empty text, and a job waiting for input stays `blocked`.
test('a chat left waiting after a turn notifies once the wait is over; a reply cancels it', async () => {
  let last: Entry | null = { at: 't0', state: 'blocked', detail: 'earlier', text: 'old reply' };
  const sent: string[] = [];
  const stop = startJobNotifications({
    readLastEntry: async () => last,
    notify: (_id, detail) => { sent.push(String(detail)); },
    delayMs: 30,
    seenAt: () => 0,
  });

  try {
    // First read after start: an old ended turn must not notify.
    await liveSessionsService.applySources([agent], [job('blocked', 'earlier')]);
    await settle();

    // The user writes: empty text, still blocked.
    last = { at: 't1', state: 'blocked', detail: 'question', text: '' };
    await liveSessionsService.applySources([agent], [job('blocked', 'question')]);
    await settle();

    // The turn ends with a reply, without passing through `working`.
    last = { at: 't2', state: 'blocked', detail: 'answer', text: 'the reply' };
    await liveSessionsService.applySources([agent], [job('blocked', 'answer')]);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(sent, ['answer'], 'notified once for the turn that ended');

    // Next turn ends, but the user replies before the wait is over.
    last = { at: 't3', state: 'blocked', detail: 'second answer', text: 'reply 2' };
    await liveSessionsService.applySources([agent], [job('blocked', 'second answer')]);
    await settle();
    last = { at: 't4', state: 'blocked', detail: 'thanks', text: '' };
    await liveSessionsService.applySources([agent], [job('blocked', 'thanks')]);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(sent, ['answer'], 'a reply within the wait cancels the notification');
  } finally {
    stop();
    liveSessionsService.setForTests(new Map());
  }
});

test('after a restart, a turn that ended moments ago still notifies for the time left', async () => {
  liveSessionsService.setForTests(new Map());
  const last: Entry = { at: new Date(Date.now() - 10).toISOString(), state: 'blocked', detail: 'recent', text: 'reply' };
  const sent: string[] = [];
  const stop = startJobNotifications({
    readLastEntry: async () => last,
    notify: (_id, detail) => { sent.push(String(detail)); },
    delayMs: 40,
    seenAt: () => 0,
  });
  try {
    await liveSessionsService.applySources([agent], [job('blocked', 'recent')]);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(sent, ['recent']);
  } finally {
    stop();
    liveSessionsService.setForTests(new Map());
  }
});

test('a chat already looked at since its turn ended does not notify', async () => {
  liveSessionsService.setForTests(new Map());
  const endedAt = new Date(Date.now() - 10).toISOString();
  const last: Entry = { at: endedAt, state: 'blocked', detail: 'seen', text: 'reply' };
  const sent: string[] = [];
  const stop = startJobNotifications({
    readLastEntry: async () => last,
    notify: (_id, detail) => { sent.push(String(detail)); },
    delayMs: 40,
    seenAt: () => Date.now(), // open on screen during the wait
  });
  try {
    await liveSessionsService.applySources([agent], [job('blocked', 'seen')]);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(sent, []);
  } finally {
    stop();
    liveSessionsService.setForTests(new Map());
  }
});
