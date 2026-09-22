import type { Action } from 'svelte/action';

export interface MenuNavParams {
	/** Called when the menu should close (Escape). */
	onEscape?: () => void;
	/** Focused when Escape closes the menu, so focus does not fall to <body>. */
	trigger?: HTMLElement | null;
}

/**
 * Roving keyboard support for the `role="menu"` popovers. The items were already
 * reachable with Tab, but arrow keys did nothing and closing a menu dropped
 * focus on `<body>` instead of back on its trigger.
 */
export const menuNav: Action<HTMLElement, MenuNavParams | undefined> = (node, params) => {
	let current = params ?? {};
	const items = () =>
		Array.from(node.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
			(el) => !el.hasAttribute('disabled')
		);
	const focusItem = (index: number) => {
		const list = items();
		if (!list.length) return;
		list[(index + list.length) % list.length].focus();
	};

	const onKey = (e: KeyboardEvent) => {
		const list = items();
		const active = document.activeElement as HTMLElement | null;
		const index = active ? list.indexOf(active) : -1;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				focusItem(index + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				focusItem(index - 1);
				break;
			case 'Home':
				e.preventDefault();
				focusItem(0);
				break;
			case 'End':
				e.preventDefault();
				focusItem(list.length - 1);
				break;
			case 'Escape':
				if (!current.onEscape) return;
				e.preventDefault();
				current.trigger?.focus?.();
				current.onEscape();
				break;
		}
	};

	node.addEventListener('keydown', onKey);
	// A menu is mounted when it opens, so this is the "menu opened" moment.
	focusItem(0);

	return {
		update(next: MenuNavParams | undefined) {
			current = next ?? {};
		},
		destroy() {
			node.removeEventListener('keydown', onKey);
		}
	};
};
