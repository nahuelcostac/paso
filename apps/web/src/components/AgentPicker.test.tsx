// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';
import { AgentPicker } from './AgentPicker';

it('shows discovered Codex models and their reasoning levels', async () => {
  const pick = vi.fn();
  render(<AgentPicker harnesses={[{ id: 'codex', found: true, path: '/codex', version: '1', session: 'signed_in', added: true, supported: true,
    models: [{ id: 'custom', label: 'Modelo nuevo', isDefault: true, efforts: ['medium', 'high'] }] }]}
  loading={false} harness="codex" model="custom" effort="" onPick={pick} onPickEffort={vi.fn()} onRefresh={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /Agent and model/ }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('radio', { name: 'Modelo nuevo (default)' })).toBeChecked();
  expect(within(dialog).getByRole('radio', { name: 'Default' })).toBeInTheDocument();
  const efforts = within(dialog).getByRole('radiogroup', { name: 'Reasoning' });
  expect(within(efforts).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Automatic', 'Medium', 'High']);
});
