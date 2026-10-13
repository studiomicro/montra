import type { CategoryKey } from './category';

/** One row of a PickerSheet. */
export interface PickerOption<T extends string> {
	value: T;
	label: string;
	hint?: string;
	/** A category tile in front of the title. */
	tile?: CategoryKey;
	/** A brand badge in front of the title (FN-43): a registry id from `#lib/shared/brands`. */
	brand?: string;
	/** A link option (navigates; works without JavaScript); without it the row calls `onselect`. */
	href?: string;
	/**
	 * Shown but not choosable (FN-16i): the row keeps its hint (why, and what to use instead), cannot be focused
	 * or clicked and is announced as disabled.
	 */
	disabled?: boolean;
}
