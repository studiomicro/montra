/** Longest goal name (FN-10), in code points after cleaning. */
export const GOAL_NAME_MAX_LENGTH = 60;
/** Longest note on a contribution, in code points after cleaning. */
export const CONTRIBUTION_NOTE_MAX_LENGTH = 200;

/** The add/edit goal form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface GoalFormValues {
	name: string;
	/** Whole units, grouped as typed (`1.250.000`). */
	target: string;
}

/** The add-contribution form's fields as typed. */
export interface ContributionFormValues {
	/** Whole units, grouped as typed. */
	amount: string;
	note: string;
}
