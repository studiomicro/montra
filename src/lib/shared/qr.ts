/**
 * A small QR code encoder (ISO/IEC 18004, byte mode, error correction level M, versions 1–10) for the install
 * guide's "scan to open on your phone" code (FN-13). Runs in the browser, so no URL is ever sent to a QR
 * service. Follows the structure of Project Nayuki's reference encoder; checked against an independent
 * encoder's matrices in qr.test.ts. Up to 213 bytes, ample for an origin.
 */

/** Byte capacity of version 10 at level M. */
export const QR_MAX_BYTES = 213;

// Level M, index = version (1–10). ISO/IEC 18004 Table 9.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format-information bits of level M. */
const LEVEL_M_BITS = 0;

/** GF(2^8) product modulo the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree - 1).fill(0);
	result.push(1);
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j] as number, root);
			if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => (result[i] = (result[i] as number) ^ gfMul(coef, factor)));
	}
	return result;
}

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

const dataCodewords = (ver: number) =>
	Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] as number) * (BLOCKS[ver] as number);

function alignmentPositions(ver: number, size: number): number[] {
	if (ver === 1) return [];
	const count = Math.floor(ver / 7) + 2;
	const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
	return result;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** The data codewords of `bytes` (mode, count, data, terminator, padding) for version `ver`. */
function dataCodewordsFor(bytes: Uint8Array, ver: number): number[] {
	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, ver < 10 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(ver) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
	return out;
}

function withEccInterleaved(data: number[], ver: number): number[] {
	const blocks = BLOCKS[ver] as number;
	const eccLen = ECC_PER_BLOCK[ver] as number;
	const raw = Math.floor(rawDataModules(ver) / 8);
	const shortBlocks = blocks - (raw % blocks);
	const shortLen = Math.floor(raw / blocks);
	const divisor = rsDivisor(eccLen);
	const parts: number[][] = [];
	for (let i = 0, k = 0; i < blocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < shortBlocks) dat.push(0);
		parts.push(dat.concat(ecc));
	}
	const result: number[] = [];
	for (let i = 0; i < (parts[0] as number[]).length; i++)
		parts.forEach((block, j) => {
			if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i] as number);
		});
	return result;
}

function masked(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

class QrSymbol {
	readonly size: number;
	readonly dark: boolean[][];
	readonly fixed: boolean[][];

	constructor(readonly ver: number) {
		this.size = ver * 4 + 17;
		this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.drawFunctionPatterns();
	}

	private set(x: number, y: number, dark: boolean) {
		(this.dark[y] as boolean[])[x] = dark;
		(this.fixed[y] as boolean[])[x] = true;
	}

	private drawFunctionPatterns() {
		const { size } = this;
		for (let i = 0; i < size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		for (const [cx, cy] of [
			[3, 3],
			[size - 4, 3],
			[3, size - 4]
		] as const)
			for (let dy = -4; dy <= 4; dy++)
				for (let dx = -4; dx <= 4; dx++) {
					const d = Math.max(Math.abs(dx), Math.abs(dy));
					const x = cx + dx;
					const y = cy + dy;
					if (x >= 0 && x < size && y >= 0 && y < size) this.set(x, y, d !== 2 && d !== 4);
				}
		const pos = alignmentPositions(this.ver, size);
		const last = pos.length - 1;
		pos.forEach((ax, i) =>
			pos.forEach((ay, j) => {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
				for (let dy = -2; dy <= 2; dy++)
					for (let dx = -2; dx <= 2; dx++)
						this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			})
		);
		this.drawFormat(0);
		if (this.ver >= 7) {
			let rem = this.ver;
			for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
			const bits = (this.ver << 12) | rem;
			for (let i = 0; i < 18; i++) {
				const a = size - 11 + (i % 3);
				const b = Math.floor(i / 3);
				this.set(a, b, bit(bits, i));
				this.set(b, a, bit(bits, i));
			}
		}
	}

	drawFormat(mask: number) {
		const { size } = this;
		const data = (LEVEL_M_BITS << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
		this.set(8, 7, bit(bits, 6));
		this.set(8, 8, bit(bits, 7));
		this.set(7, 8, bit(bits, 8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
		for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
		for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
		this.set(8, size - 8, true);
	}

	drawCodewords(codewords: number[]) {
		const { size } = this;
		let i = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < size; vert++)
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vert : vert;
					if (!this.fixed[y]?.[x] && i < codewords.length * 8) {
						(this.dark[y] as boolean[])[x] = bit(codewords[i >>> 3] as number, 7 - (i & 7));
						i++;
					}
				}
		}
	}

	applyMask(mask: number) {
		for (let y = 0; y < this.size; y++)
			for (let x = 0; x < this.size; x++)
				if (!this.fixed[y]?.[x] && masked(mask, x, y)) {
					const row = this.dark[y] as boolean[];
					row[x] = !row[x];
				}
	}

	/** ISO/IEC 18004 §7.8.3 penalty: lower is easier to scan. */
	penalty(): number {
		const { size } = this;
		const at = (x: number, y: number) => (this.dark[y] as boolean[])[x] as boolean;
		let score = 0;
		const addHistory = (run: number, history: number[]) => {
			if (history[0] === 0) run += size;
			history.pop();
			history.unshift(run);
		};
		const countPatterns = (h: number[]) => {
			const n = h[1] as number;
			const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
			return (
				(core && (h[0] as number) >= n * 4 && (h[6] as number) >= n ? 1 : 0) +
				(core && (h[6] as number) >= n * 4 && (h[0] as number) >= n ? 1 : 0)
			);
		};
		const lines = (get: (a: number, b: number) => boolean) => {
			for (let a = 0; a < size; a++) {
				let color = false;
				let run = 0;
				const history = [0, 0, 0, 0, 0, 0, 0];
				for (let b = 0; b < size; b++) {
					if (get(a, b) === color) {
						run++;
						if (run === 5) score += 3;
						else if (run > 5) score++;
					} else {
						addHistory(run, history);
						if (!color) score += countPatterns(history) * 40;
						color = get(a, b);
						run = 1;
					}
				}
				if (color) {
					addHistory(run, history);
					run = 0;
				}
				addHistory(run + size, history);
				score += countPatterns(history) * 40;
			}
		};
		lines((y, x) => at(x, y));
		lines((x, y) => at(x, y));
		for (let y = 0; y < size - 1; y++)
			for (let x = 0; x < size - 1; x++) {
				const c = at(x, y);
				if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
			}
		let dark = 0;
		for (const row of this.dark) for (const d of row) if (d) dark++;
		const total = size * size;
		score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
		return score;
	}
}

/**
 * The module matrix (`true` = dark, row by row, no quiet zone) of `text` as UTF-8, in the smallest version
 * that fits, with the lowest-penalty mask (or `mask` when given). Throws when the text is over QR_MAX_BYTES.
 */
export function qrMatrix(text: string, mask?: number): boolean[][] {
	const bytes = new TextEncoder().encode(text);
	let ver = 1;
	while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
	if (ver > 10) throw new Error('qr: text too long');
	const symbol = new QrSymbol(ver);
	symbol.drawCodewords(withEccInterleaved(dataCodewordsFor(bytes, ver), ver));
	let chosen = mask ?? 0;
	if (mask === undefined) {
		let best = Infinity;
		for (let m = 0; m < 8; m++) {
			symbol.applyMask(m);
			symbol.drawFormat(m);
			const score = symbol.penalty();
			if (score < best) {
				best = score;
				chosen = m;
			}
			symbol.applyMask(m);
		}
	}
	symbol.applyMask(chosen);
	symbol.drawFormat(chosen);
	return symbol.dark;
}

/** One SVG path (`d`) drawing every dark module of `matrix` as a unit square, offset by the quiet zone. */
export function qrPath(matrix: boolean[][], quiet = 4): string {
	const parts: string[] = [];
	matrix.forEach((row, y) =>
		row.forEach((dark, x) => {
			if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
		})
	);
	return parts.join('');
}
