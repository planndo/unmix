// Pure helpers with no imports, so they can be unit tested without Stripe or Supabase.
type StripeSub = {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number | null;
  items: { data: Array<{ current_period_end?: number | null; price?: { recurring?: { interval?: string } | null } | null }> };
};

export function subscriptionRow(sub: StripeSub, userId: string) {
  const item = sub.items.data[0];
  // Newer Stripe API versions report the period end on the item, older ones on the subscription.
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? null;
  return {
    stripe_subscription_id: sub.id,
    user_id: userId,
    status: sub.status,
    billing_interval: item?.price?.recurring?.interval ?? null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
}

export const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

export function priceFor(interval: unknown, monthly: string, yearly: string): string | null {
  if (interval === 'month') return monthly;
  if (interval === 'year') return yearly;
  return null;
}

export function allowedOrigin(origin: string | null, siteUrl: string, extra: string): string {
  const allowed = [new URL(siteUrl).origin, ...extra.split(',').map((s) => s.trim()).filter(Boolean)];
  return origin && allowed.includes(origin) ? origin : allowed[0];
}
