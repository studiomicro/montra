import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// FN-58 "Diagnosa kartu": everything happens on the device through the Android app's NFC bridge; no space data is
// read or written. Signed-in only, like every Dompet page.
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/masuk');
	return {};
};
