import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const configuredBaseUrl = (
    env.VITE_API_BASE_URL ??
    'https://9ba6-2a05-45c2-5096-8d00-25bd-cfec-69a1-d861.ngrok-free.app'
  ).trim();
  const proxyTarget = (env.VITE_API_PROXY_TARGET ?? configuredBaseUrl).trim();
  const useApiProxy = env.VITE_API_USE_PROXY !== 'false' && proxyTarget.length > 0;

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (!id.includes('node_modules')) {
              return undefined;
            }

            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router-dom/')
            ) {
              return 'vendor-react';
            }

            if (id.includes('/i18next/') || id.includes('/react-i18next/')) {
              return 'vendor-i18n';
            }

            if (id.includes('/recharts/')) {
              return 'vendor-charts';
            }

            if (
              id.includes('/react-icons/') ||
              id.includes('/@radix-ui/') ||
              id.includes('/react-day-picker/') ||
              id.includes('/date-fns/')
            ) {
              return 'vendor-ui';
            }

            return 'vendor-misc';
          },
        },
      },
    },
    server: {
      allowedHosts: ['triceps-goes-cure.ngrok-free.dev'],
      proxy: useApiProxy
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              headers: {
                'ngrok-skip-browser-warning': 'true',
              },
            },
          }
        : undefined,
    },
  };
});
