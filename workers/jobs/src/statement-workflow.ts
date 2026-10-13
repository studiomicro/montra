import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

/** Placeholder for FN-16 statement reading. One step proves the binding and class export. */
export class StatementWorkflow extends WorkflowEntrypoint<Env, { importId: string }> {
	async run(event: WorkflowEvent<{ importId: string }>, step: WorkflowStep) {
		return step.do('noop', async () => ({ importId: event.payload.importId, ok: true }));
	}
}
