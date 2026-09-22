import { tick } from 'svelte';
import type { Action } from 'svelte/action';

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => el.getClientRects().length > 0 || el === document.activeElement
	);
}

export interface DialogFocusParams {
	/** Escape handler. Omit to leave Escape to the caller. */
	onEscape?: () => void;
	/** What to focus on open. Defaults to the first focusable element. */
	initial?: HTMLElement | null;
}

/**
 * The modal keyboard contract, extracted from ConfirmDialog so the dialogs that
 * are hand-rolled cannot drift from it: focus moves inside on open, Tab cycles
 * within the dialog instead of escaping into the page behind it, Escape closes,
 * and focus returns to whatever was focused before.
 */
export const dialogFocus: Action<HTMLElement, DialogFocusParams | undefined> = (node, params) => {
	let current = params ?? {};
	let destroyed = false;
	const previouslyFocused = document.activeElement as HTMLElement | null;

	/**
	 * Focus the caller's target, else the first focusable, else the dialog.
	 *
	 * Deferred by a tick: the action runs before the dialog's children are
	 * necessarily in the DOM (and before `bind:this` on them is assigned), so
	 * focusing here and now lands on `node` — which is not focusable, so nothing
	 * moves and the dialog never takes focus at all.
	 */
	const focusInitial = () => {
		if (destroyed) return;
		const target = current.initial ?? focusables(node)[0] ?? node;
		target.focus();
		// A disabled control cannot take focus — the confirm button is disabled
		// while a draft is saving — and neither can a hidden one. Fall back to
		// whatever can, so an open dialog is never left without focus.
		if (node.contains(document.activeElement)) return;
		const fallback = focusables(node)[0];
		if (fallback && fallback !== target) fallback.focus();
		if (!node.contains(document.activeElement)) node.focus();
	};
	if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
	void tick().then(focusInitial);

	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (!current.onEscape) return;
			e.preventDefault();
			current.onEscape();
			return;
		}
		if (e.key !== 'Tab') return;
		const items = focusables(node);
		if (items.length === 0) {
			e.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	window.addEventListener('keydown', onKey);
	return {
		update(next: DialogFocusParams | undefined) {
			current = next ?? {};
		},
		destroy() {
			destroyed = true;
			window.removeEventListener('keydown', onKey);
			previouslyFocused?.focus?.();
		}
	};
};
