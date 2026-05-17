/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build-time gates. Both flipped 2026-05-17 after the codebase reached
  // a clean lint/tsc baseline — keeping these on as ignore was masking
  // future regressions.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'a.espncdn.com' },
      { protocol: 'https', hostname: 'pga-tour-res.cloudinary.com' },
    ],
  },
};

module.exports = nextConfig;
