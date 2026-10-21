import { defineConfig } from 'eslint/config';
import baseConfig from './.config/eslint.config.mjs';

export default defineConfig([{ ignores: ['**/node_modules/', '**/dist/', 'src/wasm/', '**/.eslintcache'] }, ...baseConfig]);
