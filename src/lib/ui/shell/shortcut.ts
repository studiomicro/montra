/** What `isAddShortcut` reads from a keydown event and the page around it. */
export interface ShortcutKey {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	repeat: boolean;
	defaultPrevented: boolean;
	/** The focused element is a text field, select, or editable content. */
	editable: boolean;
	/** A dialog (sheet) is already open. */
	dialogOpen: boolean;
}

/**
 * `N` opens the Tambah sheet (APP_PARITY § 1) — only as a plain key press outside text entry and outside an
 * open dialog, so typing an "n" anywhere never opens it.
 */
export function isAddShortcut(e: ShortcutKey): boolean {
	if (e.key !== 'n' && e.key !== 'N') return false;
	if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return false;
	return !e.editable && !e.dialogOpen;
}

/** Text fields, selects and editable content take typed letters; buttons, links and checkboxes do not. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).tagName !== 'string') return false;
	const el = target as HTMLElement;
	if (el.isContentEditable) return true;
	const tag = el.tagName.toLowerCase();
	if (tag === 'textarea' || tag === 'select') return true;
	if (tag !== 'input') return false;
	const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
	return ![
		'button',
		'submit',
		'reset',
		'checkbox',
		'radio',
		'range',
		'color',
		'file',
		'image'
	].includes(type);
}
