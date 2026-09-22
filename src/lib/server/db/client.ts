import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createD1Db(d1: D1Database) {
	return drizzleD1(d1, { schema });
}

/**
 * Run independent reads in a single database round trip (one D1 batch call in
 * prod, one libsql batch call in tests). Drizzle types batch results as
 * unknown[], so callers destructure and cast positionally. Reads only: a
 * failed statement fails the whole batch.
 */
export function batchQueries(db: AppDb, queries: unknown[]): Promise<unknown[]> {
	const capable = db as unknown as { batch: (q: unknown[]) => Promise<unknown[]> };
	return capable.batch(queries);
}

/** Async SQLite surface shared by D1 (prod) and libsql (tests). */
export type AppDb = BaseSQLiteDatabase<'async', unknown, typeof schema>;

export function newId(): string {
	return crypto.randomUUID();
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Split an id list into D1-safe IN() chunks (bound-variable limit). Query
 * each chunk and concatenate. Keeps list endpoints flat-capped instead of
 * crashing once a user accumulates hundreds of drafts.
 */
export const IN_CHUNK_SIZE = 100;

export function chunkIds(ids: string[], size: number = IN_CHUNK_SIZE): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
	return out;
}

export async function first<T>(rows: Promise<T[]> | T[]): Promise<T | undefined> {
	const list = await rows;
	return list[0];
}
