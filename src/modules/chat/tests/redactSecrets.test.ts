import assert from 'node:assert/strict';

import { test } from 'vitest';

import { REDACTED, redactSecrets } from '@/modules/chat/utils/redactSecrets';

test('hides passwords and tokens in shell commands', () => {
  assert.equal(
    redactSecrets("sshpass -p 'hunter2!' ssh root@host uptime"),
    `sshpass -p ${REDACTED} ssh root@host uptime`,
  );
  assert.equal(redactSecrets('mysql --password=s3cret -u app'), `mysql --password=${REDACTED} -u app`);
  assert.equal(redactSecrets('NPM_PASS="abc def" ./run'), `NPM_PASS=${REDACTED} ./run`);
  assert.equal(
    redactSecrets("curl -H 'Authorization: Bearer abcdef1234567890' https://x"),
    `curl -H 'Authorization: Bearer ${REDACTED}' https://x`,
  );
  assert.equal(redactSecrets('git clone https://me:tok123@github.com/a/b'), `git clone https://me:${REDACTED}@github.com/a/b`);
  assert.equal(redactSecrets('export T=sk-ant-oat01-abcdefghijkl'), `export T=${REDACTED}`);
});

test('leaves ordinary commands alone', () => {
  for (const command of ['ls -la /root', 'npm run typecheck', 'git log --oneline -5', 'ssh -p 2222 host']) {
    assert.equal(redactSecrets(command), command);
  }
});
