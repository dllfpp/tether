import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

const input = {
  questions: [{
    question: 'Which colour?',
    header: 'Colour',
    multiSelect: false,
    options: [{ label: 'Red', description: 'first' }, { label: 'Green', description: 'second' }],
  }],
};

test("a background job's open question is answerable on its own card", () => {
  render(
    <PermissionContext.Provider
      value={{
        pendingPermissionRequests: [{ requestId: 'job-question:toolu_1', toolName: 'AskUserQuestion', input }],
        handlePermissionDecision: () => undefined,
      }}
    >
      <ToolRenderer toolName="AskUserQuestion" toolInput={JSON.stringify(input)} toolId="toolu_1" mode="input" />
    </PermissionContext.Provider>,
  );

  // The interactive panel numbers its options and offers a Skip.
  assert.ok(screen.getAllByText('Red').length > 0);
  assert.ok(screen.getByText(/skip/i));
});
