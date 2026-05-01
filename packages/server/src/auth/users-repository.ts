import type { User, UserPublic } from '@banshee-forge/shared';
import { generateUserId } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

interface UsersFile {
	users: User[];
}

const FILE_PATH = 'auth/users.json';

function toPublic(user: User): UserPublic {
	return {
		id: user.id,
		username: user.username,
		createdAt: user.createdAt,
		lastLoginAt: user.lastLoginAt,
	};
}

export class UsersRepository {
	constructor(private storage: JsonFileStorage) {}

	async list(): Promise<UserPublic[]> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		return data.users.map(toPublic);
	}

	async count(): Promise<number> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		return data.users.length;
	}

	async getById(id: string): Promise<User | null> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		return data.users.find(u => u.id === id) ?? null;
	}

	async getByUsername(username: string): Promise<User | null> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		const lower = username.toLowerCase();
		return data.users.find(u => u.username.toLowerCase() === lower) ?? null;
	}

	async create(username: string, passwordHash: string): Promise<UserPublic> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		const lower = username.toLowerCase();
		if (data.users.some(u => u.username.toLowerCase() === lower))
			throw new Error(`User '${username}' already exists`);

		const user: User = {
			id: generateUserId(),
			username,
			passwordHash,
			createdAt: new Date().toISOString(),
		};
		data.users.push(user);
		await this.storage.write<UsersFile>(FILE_PATH, data);
		return toPublic(user);
	}

	async setPassword(username: string, passwordHash: string): Promise<boolean> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		const lower = username.toLowerCase();
		const user = data.users.find(u => u.username.toLowerCase() === lower);
		if (!user) return false;
		user.passwordHash = passwordHash;
		await this.storage.write<UsersFile>(FILE_PATH, data);
		return true;
	}

	async delete(username: string): Promise<boolean> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		const lower = username.toLowerCase();
		const index = data.users.findIndex(u => u.username.toLowerCase() === lower);
		if (index === -1) return false;
		data.users.splice(index, 1);
		await this.storage.write<UsersFile>(FILE_PATH, data);
		return true;
	}

	async updateLastLogin(userId: string): Promise<void> {
		const data = await this.storage.read<UsersFile>(FILE_PATH, { users: [] });
		const user = data.users.find(u => u.id === userId);
		if (!user) return;
		user.lastLoginAt = new Date().toISOString();
		await this.storage.write<UsersFile>(FILE_PATH, data);
	}
}
