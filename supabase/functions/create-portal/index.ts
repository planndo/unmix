import { customerIdFor, endpoint, HttpError, siteUrl, stripe } from '../_shared/server.ts';

endpoint(async (user) => {
  const customer = await customerIdFor(user.id);
  if (!customer) throw new HttpError(404, "You don't have any billing history yet.");
  const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${siteUrl()}/account.html` });
  return { url: session.url };
});
