// Entry point for `node --import`. Keeps the loader registration in one place.
import { register } from 'node:module';
register('./tsx-loader.mjs', import.meta.url);
