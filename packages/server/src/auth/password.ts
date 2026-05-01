import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;

/** Hash a plaintext password for storage. */
export async function hashPassword(plain: string): Promise<string> {
	return bcrypt.hash(plain, BCRYPT_COST);
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
	return bcrypt.compare(plain, hash);
}
