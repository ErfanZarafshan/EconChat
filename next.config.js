/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse uses fs at module load; this keeps it on the server.
  serverExternalPackages: ['pdf-parse'],
};

module.exports = nextConfig;
