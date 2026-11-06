import { admin, env, stripe } from '../_shared/server.ts';
import { subscriptionRow } from '../_shared/subscription.ts';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const s = stripe();
  let event;
  try {
    event = await s.webhooks.constructEventAsync(await req.text(), signature, env('STRIPE_WEBHOOK_SECRET'));
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return new Response('ignored');

  try {
    // Stripe can deliver events late or out of order, so read the current state rather than trusting the payload.
    const current = await s.subscriptions.retrieve((event.data.object as { id: string }).id);
    const customer = typeof current.customer === 'string' ? current.customer : current.customer.id;
    const db = admin();
    const { data: owner, error: ownerError } = await db.from('customers').select('user_id').eq('stripe_customer_id', customer).maybeSingle();
    if (ownerError) throw ownerError;
    if (!owner) {
      // Customers are only created through create-checkout, so this is an account that was just
      // deleted or an unrelated subscription on the same Stripe account. Retrying will not help.
      console.warn(`No Unmix account for Stripe customer ${customer}`);
      return new Response('unknown customer');
    }
    const { error } = await db.from('subscriptions').upsert(subscriptionRow(current, owner.user_id));
    if (error) throw error;
    return new Response('ok');
  } catch (err) {
    console.error(err);
    return new Response('Temporary failure', { status: 500 }); // Stripe retries non-2xx responses
  }
});
