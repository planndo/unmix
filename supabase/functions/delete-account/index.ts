import { admin, customerIdFor, endpoint, HttpError, stripe } from '../_shared/server.ts';

endpoint(async (user, body) => {
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
  // Deleting the Stripe customer cancels their subscriptions, so nobody is billed after leaving.
  // Stripe keeps its own invoice records. Do this first: if it fails the account stays intact.
  const customer = await customerIdFor(user.id);
  if (customer) {
    await stripe().customers.del(customer).catch((err) => {
      // Already gone from an earlier attempt that failed below: carry on so a retry can finish.
      if (err?.code !== 'resource_missing') throw err;
    });
  }
  const { error } = await admin().auth.admin.deleteUser(user.id); // our tables cascade from auth.users
  if (error) throw error;
  return { deleted: true };
});
