/** A notice is gone: focus moves to the page's main region instead of being lost to <body>. */
export function focusMain(): void {
	const main = document.querySelector('main');
	if (main) {
		main.setAttribute('tabindex', '-1');
		main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
		main.focus();
	}
}
