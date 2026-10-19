import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { promptWithAttachments } from '@/modules/websocket/services/chat-websocket.service.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

// Regression: turns delivered to a daemon job used to drop their screenshots.
test('a job turn carries its uploaded files as paths', () => {
  const store = getGlobalImageAssetsDir();
  const prompt = promptWithAttachments({
    content: 'guarda la differenza',
    options: { images: [{ path: 'shot.png', name: 'shot.png', mimeType: 'image/png' }] },
  });
  assert.equal(prompt, `guarda la differenza\n\nAttached files:\n${path.join(store, 'shot.png')}`);
});

test('files outside the upload store never reach the job', () => {
  const prompt = promptWithAttachments({
    content: 'ciao',
    options: { files: [{ path: '/etc/passwd', name: 'passwd' }] },
  });
  assert.equal(prompt, 'ciao');
});

test('a turn without attachments is sent unchanged', () => {
  assert.equal(promptWithAttachments({ content: 'solo testo' }), 'solo testo');
});
