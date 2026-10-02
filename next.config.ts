import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite is a WASM build of Postgres. Next does not have it on its automatic external
  // list, so bundling it is how the database silently stops working in a build.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default nextConfig;