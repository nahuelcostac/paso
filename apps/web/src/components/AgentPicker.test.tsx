// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentPicker } from './AgentPicker';

afterEach(cleanup);

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

it('offers Antigravity models and the levels each one has', async () => {
  const agy = { id: 'agy' as const, found: true, path: '/agy', version: '1.5.16', session: 'unknown' as const, added: true, supported: true };
  const { rerender } = render(<AgentPicker harnesses={[agy]} loading={false} harness="agy" model="gemini-4-neon" effort="" onPick={vi.fn()} onPickEffort={vi.fn()} onRefresh={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /Agent and model/ }));
  const dialog = () => screen.getByRole('dialog');
  expect(within(within(dialog()).getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio').map((item) => item.textContent))
    .toEqual(['Default', 'Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Argon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash']);
  const levels = () => within(within(dialog()).getByRole('radiogroup', { name: 'Reasoning' })).getAllByRole('radio').map((item) => item.textContent);
  expect(levels()).toEqual(['Automatic', 'Low', 'Medium', 'High', 'Very high']);
  rerender(<AgentPicker harnesses={[agy]} loading={false} harness="agy" model="gemini-3.8-flash" effort="" onPick={vi.fn()} onPickEffort={vi.fn()} onRefresh={vi.fn()} />);
  expect(levels()).toEqual(['Automatic', 'Low', 'Medium', 'High']);
});
