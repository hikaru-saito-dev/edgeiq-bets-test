import { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { Whop } from '@whop/sdk';
import type { Payment } from '@whop/sdk/resources.js';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('WHOP_WEBHOOK_SECRET environment variable is required');
}

// Initialize Whop SDK with webhook key (base64 encoded)
const whopSdk = new Whop({
  appID: process.env.NEXT_PUBLIC_WHOP_APP_ID,
  apiKey: process.env.WHOP_API_KEY || '',
  webhookKey: btoa(WEBHOOK_SECRET),
});

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Get raw request body as text
    const requestBodyText = await request.text();

    if (!requestBodyText || requestBodyText.length === 0) {
      return new Response('Empty request body', { status: 400 });
    }

    // Get headers as plain object (required by Whop SDK)
    const headers = Object.fromEntries(request.headers);

    // Verify and unwrap webhook
    let webhookData;
    try {
      webhookData = whopSdk.webhooks.unwrap(requestBodyText, { headers });
    } catch (error) {
      // Return 401 for signature verification failures
      return new Response('Invalid webhook signature', { status: 401 });
    }

    // Handle payment succeeded events
    if (webhookData.type === 'payment.succeeded') {
      waitUntil(handlePaymentSucceeded(webhookData.data));
    }

    // Return 200 OK quickly to prevent webhook retries
    return new Response('OK', { status: 200 });
  } catch (error) {
    // Return 500 for unexpected errors
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Process payment succeeded webhook
 * Runs asynchronously via waitUntil to avoid blocking the response
 */
async function handlePaymentSucceeded(payment: Payment): Promise<void> {
  try {
    await connectDB();

    const planId = payment.plan?.id;
    if (!planId) {
      return;
    }

    // Extract metadata from payment object
    const paymentMetadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };

    // Also check checkout_configuration metadata
    const checkoutConfig = (payment as unknown as Record<string, unknown>).checkout_configuration as
      | Record<string, unknown>
      | undefined;
    const checkoutMetadata = (checkoutConfig?.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };

    // Merge metadata (checkout metadata takes precedence)
    const metadata = { ...paymentMetadata, ...checkoutMetadata };

    // Only process follow purchase webhooks
    if (!metadata.followPurchase) {
      return;
    }

    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || payment.company?.id;
    const numPlays = metadata.numPlays || 10;
    const followerWhopUserId = payment.user?.id;

    // Validate required fields
    if (!capperUserId || !capperCompanyId || !followerWhopUserId) {
      return;
    }

    // Check if we already processed this payment (prevent duplicates)
    const existingPurchase = await FollowPurchase.findOne({
      paymentId: payment.id,
    });

    if (existingPurchase) {
      return;
    }

    // Find the follower user (the person who purchased)
    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
      companyId: capperCompanyId,
    });

    if (!followerUser) {
      return;
    }

    // Find the capper (content creator being followed)
    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      return;
    }

    // Verify plan ID matches the capper's current follow offer plan
    if (capperUser.followOfferPlanId !== planId) {
      return;
    }

    // Create follow purchase record
    const followPurchase = new FollowPurchase({
      followerUserId: followerUser._id,
      capperUserId: capperUser._id,
      companyId: capperCompanyId,
      numPlaysPurchased: numPlays,
      numPlaysConsumed: 0,
      status: 'active',
      planId: planId,
      paymentId: payment.id,
    });

    await followPurchase.save();
  } catch (error) {
    // Silently handle errors in async function
    // Errors are logged but don't affect webhook response
  }
}
