import { BCA } from './bca.ts';
import { BNI } from './bni.ts';
import { MANDIRI } from './mandiri.ts';
import { OCBC } from './ocbc.ts';
import type { StatementParser } from './types.ts';

/**
 * Every institution FN-16a can read. A parser (`bca.ts`, …) is written and listed here only from a real,
 * redacted sample in `.superpowers/ref/samples/statements/`, never from a guessed layout (PRD owner decision A).
 * Anything no parser claims answers "format belum didukung" with what was detected.
 */
export const STATEMENT_PARSERS: readonly StatementParser[] = [BCA, BNI, MANDIRI, OCBC];
