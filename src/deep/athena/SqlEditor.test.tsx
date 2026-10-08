import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SqlEditor } from './SqlEditor';

/**
 * Ace is loaded lazily and is the one part of this screen that can fail to
 * arrive — a blocked chunk, an offline embedded deployment. When it does, the
 * editor degrades to a plain Cloudscape textarea rather than leaving the user
 * with no way to type a query at all.
 */
vi.mock('./ace', () => {
  throw new Error('ace is unavailable in this test');
});

describe('SqlEditor', () => {
  it('falls back to a textarea when ace cannot load, and still edits', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SqlEditor value="SELECT 1;" onChange={onChange} onRun={() => {}} />);

    const fallback = await screen.findByTestId('sql-editor-fallback');
    await user.type(textareaOf(fallback), ' ');
    expect(onChange).toHaveBeenCalled();
  });

  it('runs the query on Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<SqlEditor value="SELECT 1;" onChange={() => {}} onRun={onRun} />);

    const fallback = await screen.findByTestId('sql-editor-fallback');
    await user.click(textareaOf(fallback));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('does not run while a query is already running', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<SqlEditor value="SELECT 1;" onChange={() => {}} onRun={onRun} disabled />);

    const fallback = await screen.findByTestId('sql-editor-fallback');
    await user.click(textareaOf(fallback));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onRun).not.toHaveBeenCalled();
  });
});

function textareaOf(container: HTMLElement): HTMLElement {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('the fallback editor rendered no textarea');
  return textarea;
}
