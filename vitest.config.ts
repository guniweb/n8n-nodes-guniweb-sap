import { defineConfig } from 'vitest/config';

export default defineConfig({
	// n8n-workflow ships source maps that point at files not in the package — not our problem.
	logLevel: 'error',
	test: {
		include: ['tests/**/*.test.ts'],
	},
});
