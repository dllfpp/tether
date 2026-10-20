import assert from 'node:assert/strict';
import test from 'node:test';

import { hasLeadingIcon, iconForName } from '@/modules/live-sessions/services/session-icons.service.js';

test('the topic icon comes from keywords in the name', () => {
  assert.equal(iconForName('Office switch migration'), '🖥️');
  assert.equal(iconForName('proxmox cluster check'), '🗄️');
  assert.equal(iconForName('security log review'), '🔒');
  assert.equal(iconForName('Tesla price watch'), '🚗');
  assert.equal(iconForName('something without a topic'), null);
});

test('a name that already starts with an emoji keeps it', () => {
  assert.equal(hasLeadingIcon('🚀 My project'), true);
  assert.equal(hasLeadingIcon('🖥️ Switch migration'), true);
  assert.equal(hasLeadingIcon('Switch migration'), false);
});
