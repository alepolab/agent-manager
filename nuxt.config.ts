export default defineNuxtConfig({
  modules: ['@nuxt/ui'],

  devtools: { enabled: false },

  future: { compatibilityVersion: 4 },

  css: ['~/assets/css/main.css'],

  compatibilityDate: '2025-01-15',

  runtimeConfig: {
    claudeDir: process.env.CLAUDE_DIR || '',
    claudeCliPath: process.env.CLAUDE_CLI_PATH || '',
  },

  nitro: {
    experimental: {
      websocket: true,
    },
  },

  app: {
    head: {
      title: 'Claude Code Agent Manager',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'description', content: 'Visual manager for Claude Code agents, commands, skills, and plugins. Configure AI assistants without touching the terminal.' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#F7F8FA' },
        { property: 'og:title', content: 'Agent Manager — Claude Code' },
        { property: 'og:description', content: 'Visual manager for Claude Code agents, commands, skills, and plugins. Configure AI assistants without touching the terminal.' },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://api.fontshare.com/v2/css?f[]=clash-display@400,500,600,700&display=swap' },
        { rel: 'stylesheet', href: 'https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5.0.3/index.css' },
        { rel: 'stylesheet', href: 'https://cdn.jsdelivr.net/npm/@fontsource/geist-mono@5.0.3/index.css' },
      ],
    },
    pageTransition: { name: 'page', mode: 'out-in' },
  },

  components: [
    { path: '~/components/chat', pathPrefix: false },
    { path: '~/components/studio', pathPrefix: false },
    { path: '~/components/cli', pathPrefix: false },
    { path: '~/components' },
  ],

  colorMode: {
    preference: 'light',
  },

  routeRules: {
    '/templates': { redirect: '/explore' },
  },
})
