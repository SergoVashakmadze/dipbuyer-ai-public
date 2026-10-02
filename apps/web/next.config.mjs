/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [
      // One canonical host.
      { source: "/", has: [{ type: "host", value: "www.dipbuyer.ai" }], destination: "https://dipbuyer.ai/", permanent: true },
      { source: "/:path+", has: [{ type: "host", value: "www.dipbuyer.ai" }], destination: "https://dipbuyer.ai/:path+", permanent: true },
      // Pages of the previous dipbuyer.ai site that search engines still list.
      { source: "/white-paper", destination: "/methodology", permanent: true },
      { source: "/auto-invest", destination: "/autopilot", permanent: true },
      { source: "/dashboard", destination: "/portfolio", permanent: true },
      { source: "/tokens", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
