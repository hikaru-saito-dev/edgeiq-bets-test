import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';
import { Whop } from '@whop/sdk';
import type { Payment } from '@whop/sdk/resources.js';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('WHOP_WEBHOOK_SECRET environment variable is required');
}

// Initialize Whop SDK with webhookKey (Base64 encoded)
const whopSdk = new Whop({
  appID: process.env.NEXT_PUBLIC_WHOP_APP_ID,
  apiKey: process.env.WHOP_API_KEY || '',
  webhookKey: Buffer.from(WEBHOOK_SECRET, 'utf8').toString('base64'),
});

/**
 * POST /api/follow_checkout
 * Webhook endpoint to receive payment.succeeded events from Whop
 * Creates FollowPurchase records when users purchase follow offers
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    // Get raw body as string for signature verification
    const body = await request.text();
    
    if (!body || body.length === 0) {
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }

    // Convert headers to plain object for SDK
    const headers = Object.fromEntries(request.headers);

    // Validate and unwrap webhook
    let webhookData;
    try {
      webhookData = whopSdk.webhooks.unwrap(body, { headers });
    } catch (error) {
      // Handle test webhooks that may not have proper signatures
      try {
        const parsed = JSON.parse(body);
        if (parsed.action === 'payment.succeeded' && parsed.data === null) {
          // Test webhook with null data - acknowledge it
          return NextResponse.json({ received: true, test: true }, { status: 200 });
        }
      } catch {
        // Invalid JSON or webhook - return error
      }
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    // Handle the webhook event
    if (webhookData.type === 'payment.succeeded') {
      // Process payment (fire and forget - return quickly)
      handlePaymentSucceeded(webhookData.data).catch(() => {
        // Errors are handled internally
      });
      // Return quickly to prevent webhook retries
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Other webhook types - just acknowledge
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    // Return 500 so Whop will retry
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handlePaymentSucceeded(payment: Payment) {
  try {
    await connectDB();

    const planId = payment.plan?.id;
    
    // Check metadata in both payment.metadata and checkout_configuration.metadata
    const paymentMetadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };
    
    // Access checkout_configuration via type assertion
    const paymentWithCheckout = payment as typeof payment & {
      checkout_configuration?: {
        metadata?: {
          followPurchase?: boolean;
          capperUserId?: string;
          capperCompanyId?: string;
          numPlays?: number;
        };
      };
    };
    
    const checkoutMetadata = (paymentWithCheckout.checkout_configuration?.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };
    
    const metadata = { ...checkoutMetadata, ...paymentMetadata };

    // Check if this is a follow purchase
    if (!metadata.followPurchase || !planId) {
      return; // Not a follow purchase
    }

    // Extract follow purchase details from metadata
    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || payment.company?.id;
    const numPlays = metadata.numPlays || 10;
    const followerWhopUserId = payment.user?.id;

    if (!capperUserId || !capperCompanyId || !followerWhopUserId) {
      return; // Missing required metadata
    }

    // Check if payment already processed (prevent duplicates)
    const existingPurchase = await FollowPurchase.findOne({
      paymentId: payment.id,
    });

    if (existingPurchase) {
      return; // Already processed
    }

    // Find follower user by Whop userId and companyId
    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
      companyId: capperCompanyId,
    });

    if (!followerUser) {
      return; // Follower user not found
    }

    // Find capper user
    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      return; // Capper user not found
    }

    // Verify this plan ID matches the capper's follow offer plan
    if (capperUser.followOfferPlanId !== planId) {
      return; // Plan ID mismatch
    }

    // Create FollowPurchase record
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
    // Errors are handled silently - we've already returned 200 to Whop
    // This prevents webhook retries for non-recoverable errors
  }
}
