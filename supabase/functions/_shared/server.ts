import { createClient, type User } from 'npm:@supabase/supabase-js@2.119.0';
import Stripe from 'npm:stripe@23.1.0';
import { allowedOrigin } from './subscription.ts';

export const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
};

export const stripe = () => new Stripe(env('STRIPE_SECRET_KEY'));
export const admin = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

export const siteUrl = () => env('SITE_URL').replace(/\/+$/, '');

const corsHeaders = (req: Request) => ({
  'Access-Control-Allow-Origin': allowedOrigin(req.headers.get('origin'), env('SITE_URL'), Deno.env.get('EXTRA_ALLOWED_ORIGINS') ?? ''),
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function requireUser(req: Request): Promise<User> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Please sign in again.');
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Please sign in again.');
  return data.user;
}

// Wraps a signed-in JSON endpoint with CORS, authentication and error handling.
export function endpoint(handler: (user: User, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  Deno.serve(async (req) => {
    const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') return new Response('ok', { headers });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    try {
      const user = await requireUser(req);
      const body = await req.json().catch(() => ({}));
      return new Response(JSON.stringify(await handler(user, body)), { headers });
    } catch (err) {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: err.message }), { status: err.status, headers });
      console.error(err);
      return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), { status: 500, headers });
    }
  });
}

export async function customerIdFor(userId: string): Promise<string | null> {
  const { data, error } = await admin().from('customers').select('stripe_customer_id').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.stripe_customer_id ?? null;
}
