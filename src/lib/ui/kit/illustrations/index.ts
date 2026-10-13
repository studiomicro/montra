import type { Component } from 'svelte';
import Broken from './Broken.svelte';
import Budget from './Budget.svelte';
import Calendar from './Calendar.svelte';
import Goal from './Goal.svelte';
import Growth from './Growth.svelte';
import History from './History.svelte';
import Inbox from './Inbox.svelte';
import Parcels from './Parcels.svelte';
import People from './People.svelte';
import Wallet from './Wallet.svelte';
import Welcome from './Welcome.svelte';

/**
 * The scenes `<Illustration name>` draws (FN-40 Part 3): original isometric artwork made for this app. A later
 * Rive file per name can replace a scene behind the same name.
 */
export const SCENES = {
	broken: Broken,
	budget: Budget,
	calendar: Calendar,
	goal: Goal,
	growth: Growth,
	history: History,
	inbox: Inbox,
	parcels: Parcels,
	people: People,
	wallet: Wallet,
	welcome: Welcome
} satisfies Record<string, Component>;

export type IllustrationName = keyof typeof SCENES;
