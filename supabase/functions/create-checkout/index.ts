import { admin, customerIdFor, endpoint, env, HttpError, siteUrl, stripe } from '../_shared/server.ts';
import { ACTIVE_STATUSES, priceFor } from '../_shared/subscription.ts';

endpoint(async (user, body) => {
  const price = priceFor(body.interval, env('STRIPE_PRICE_MONTHLY'), env('STRIPE_PRICE_YEARLY'));
  if (!price) throw new HttpError(400, 'Choose monthly or yearly billing.');

  const db = admin();
  const { data: subs, error } = await db.from('subscriptions').select('status').eq('user_id', user.id);
  if (error) throw error;
  if (subs?.some((s) => ACTIVE_STATUSES.includes(s.status))) throw new HttpError(409, 'You already have Pro. Manage it from your account page.');

  const s = stripe();
  let customer = await customerIdFor(user.id);
  if (!customer) {
    // The idempotency key stops a double click from creating two Stripe customers.
    const created = await s.customers.create(
      { email: user.email, metadata: { user_id: user.id } },
      { idempotencyKey: `customer-${user.id}` },
    );
    customer = created.id;
    const { error: saveError } = await db.from('customers').upsert({ user_id: user.id, stripe_customer_id: customer });
    if (saveError) throw saveError;
  }

  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    automatic_tax: { enabled: Deno.env.get('STRIPE_AUTOMATIC_TAX') === 'true' },
    customer_update: { address: 'auto' },
    success_url: `${siteUrl()}/account.html?checkout=success`,
    cancel_url: `${siteUrl()}/pricing.html?checkout=cancelled`,
  });
  return { url: session.url };
});
