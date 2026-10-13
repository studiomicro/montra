import { describe, expect, it } from 'vitest';
import { isAddShortcut, isEditableTarget, type ShortcutKey } from './shortcut';

const press = (over: Partial<ShortcutKey> = {}): ShortcutKey => ({
	key: 'n',
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	repeat: false,
	defaultPrevented: false,
	editable: false,
	dialogOpen: false,
	...over
});

describe('isAddShortcut (N opens Tambah)', () => {
	it('accepts a plain n or N', () => {
		expect(isAddShortcut(press())).toBe(true);
		expect(isAddShortcut(press({ key: 'N' }))).toBe(true);
	});
	it('ignores other keys and modified presses (Ctrl+N is the browser’s new window)', () => {
		expect(isAddShortcut(press({ key: 'm' }))).toBe(false);
		expect(isAddShortcut(press({ ctrlKey: true }))).toBe(false);
		expect(isAddShortcut(press({ metaKey: true }))).toBe(false);
		expect(isAddShortcut(press({ altKey: true }))).toBe(false);
		expect(isAddShortcut(press({ repeat: true }))).toBe(false);
		expect(isAddShortcut(press({ defaultPrevented: true }))).toBe(false);
	});
	it('never fires while typing or with a sheet already open', () => {
		expect(isAddShortcut(press({ editable: true }))).toBe(false);
		expect(isAddShortcut(press({ dialogOpen: true }))).toBe(false);
	});
});

describe('isEditableTarget', () => {
	const el = (tagName: string, extra: Record<string, unknown> = {}) =>
		({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
	it('treats text fields, textareas, selects and editable content as typing targets', () => {
		expect(isEditableTarget(el('INPUT', { type: 'text' }))).toBe(true);
		expect(isEditableTarget(el('INPUT', { type: 'search' }))).toBe(true);
		expect(isEditableTarget(el('INPUT', { type: '' }))).toBe(true);
		expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
		expect(isEditableTarget(el('SELECT'))).toBe(true);
		expect(isEditableTarget(el('DIV', { isContentEditable: true }))).toBe(true);
	});
	it('lets the shortcut through on buttons, links, checkboxes and the page', () => {
		expect(isEditableTarget(el('BUTTON'))).toBe(false);
		expect(isEditableTarget(el('A'))).toBe(false);
		expect(isEditableTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
		expect(isEditableTarget(el('BODY'))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
		expect(isEditableTarget({} as EventTarget)).toBe(false);
	});
});
