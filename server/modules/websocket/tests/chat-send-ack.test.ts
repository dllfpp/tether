import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptClientMessageId,
  attachmentNamesForLog,
} from '@/modules/websocket/services/chat-websocket.service.js';

// A turn resent after a missing ack (half-dead socket) must not run twice.
test('a client message id is taken once, a resend is refused', () => {
  const now = 1_000_000;
  assert.equal(acceptClientMessageId('ack-test-1', now), true);
  assert.equal(acceptClientMessageId('ack-test-1', now + 5_000), false);
  assert.equal(acceptClientMessageId('ack-test-2', now + 5_000), true);
});

test('frames without a client id are always accepted', () => {
  assert.equal(acceptClientMessageId(null), true);
  assert.equal(acceptClientMessageId(null), true);
});

test('seen ids expire after ten minutes', () => {
  const now = 2_000_000;
  assert.equal(acceptClientMessageId('ack-test-old', now), true);
  assert.equal(acceptClientMessageId('ack-test-other', now + 11 * 60 * 1000), true);
  assert.equal(acceptClientMessageId('ack-test-old', now + 11 * 60 * 1000), true);
});

test('the log lists attachment file names only', () => {
  const names = attachmentNamesForLog({
    content: 'secret text',
    options: { attachments: [{ path: '/root/.cloudcli/assets/voice-1.webm', name: 'voice-1.webm', mimeType: 'audio/webm' }] },
  });
  assert.deepEqual(names, ['voice-1.webm']);
});
