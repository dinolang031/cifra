# CIFRA

CIFRA is a Croatian daily price-guessing game built with React, TypeScript and Vite.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## Question database

Illustrative questions are maintained in `src/data/questions.ts`. Replace demo prices with verified sources before publishing an official challenge.

## Environment variables

No environment variables are required for the current MVP. Optional future configuration is documented in `.env.example`. Never commit real `.env` files or credentials.

## Deployment

The project can be deployed to Cloudflare Pages or another static-hosting provider. Build command: `npm run build`. Output directory: `dist`.
