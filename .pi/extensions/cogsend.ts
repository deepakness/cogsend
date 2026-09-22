import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, '../..');
const skillsDir = resolve(packageRoot, 'skills');

interface PiLike {
	on(event: 'resources_discover', handler: () => Promise<{ skillPaths: string[] }>): void;
}

export default function cogsendPiExtension(pi: PiLike) {
	pi.on('resources_discover', async () => ({
		skillPaths: [skillsDir]
	}));
}
