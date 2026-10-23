import type { Configuration } from 'webpack';
import { merge } from 'webpack-merge';

import grafanaConfig, { type Env } from './.config/webpack/webpack.config';

// wasm-bindgen's `--target web` glue fetches the module itself; webpack only emits it and hands over its URL.
const config = async (env: Env): Promise<Configuration> =>
  merge(await grafanaConfig(env), {
    module: { rules: [{ test: /\.wasm$/, type: 'asset/resource' }] },
  });

export default config;
