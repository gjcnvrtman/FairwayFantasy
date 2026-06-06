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
  experimental: {
    // pdfkit ships its built-in Helvetica/Courier/Times fonts as .afm
    // files under node_modules/pdfkit/js/data/. It reads them with a
    // path relative to its own bundle at runtime. When webpack inlines
    // pdfkit into a chunk under .next/server/chunks/, the data/ dir is
    // NOT copied — every doc.text() then throws ENOENT on
    // '.next/server/chunks/data/Helvetica.afm' and the daily-scorecard
    // email goes out with no PDF (see sync.ts:detectAndSendDailyScorecards).
    // Marking pdfkit as a server external leaves it loadable via a
    // normal require() from node_modules at runtime, where its data/
    // directory is intact.
    serverComponentsExternalPackages: ['pdfkit'],
  },
};

module.exports = nextConfig;
