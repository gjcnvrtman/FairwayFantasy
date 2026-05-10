// NextAuth catch-all route — the App Router export pattern.
// `handlers` is `{ GET, POST }` from the auth config.

import { handlers } from '@/auth';

export const { GET, POST } = handlers;

// Auth.js relies on session cookies + dynamic request headers, so
// this route can never be statically prerendered.
export const dynamic = 'force-dynamic';
