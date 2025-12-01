import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';
import { Whop } from '@whop/sdk';
import type { PaymentSucceededWebhookEvent } from '@whop/sdk/resources/webhooks';

export const runtime = 'nodejs';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || 'ws_a001c8771fdac4ab5a4fcff6c5bfdda0c8ebed9ca3df983b6490e79c4781f7d5';

/**
 * POST /api/follow_checkout
 * Webhook endpoint to receive payment.succeeded events from Whop
 * Creates FollowPurchase records when users purchase follow offers
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // Get raw body for signature verification
    const body = await request.text();
    
    // Get headers for webhook verification
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Initialize Whop SDK for webhook verification
    const whopClient = new Whop({
      apiKey: process.env.WHOP_API_KEY || '',
    });

    // Verify and unwrap webhook
    let event: PaymentSucceededWebhookEvent;
    try {
      const unwrapped = whopClient.webhooks.unwrap(body, {
        headers,
        key: WEBHOOK_SECRET,
      });

      // Type guard to check if it's a payment.succeeded event
      if (unwrapped.type !== 'payment.succeeded') {
        // Not a payment.succeeded event, but webhook is valid - return 200
        return NextResponse.json({ received: true }, { status: 200 });
      }

      event = unwrapped as PaymentSucceededWebhookEvent;
    } catch (error) {
      // Signature verification failed
      console.error('Webhook signature verification failed:', error);
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    // Extract payment data
    const payment = event.data;
    const planId = payment.plan?.id;
    const metadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };

    // Check if this is a follow purchase
    if (!metadata.followPurchase || !planId) {
      // Not a follow purchase, but webhook is valid - return 200
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Extract follow purchase details from metadata
    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || payment.company?.id;
    const numPlays = metadata.numPlays || 10;
    const followerWhopUserId = payment.user?.id;

    if (!capperUserId || !capperCompanyId || !followerWhopUserId) {
      console.error('Missing required metadata for follow purchase:', {
        capperUserId,
        capperCompanyId,
        followerWhopUserId,
      });
      return NextResponse.json(
        { error: 'Missing required metadata' },
        { status: 400 }
      );
    }

    // Check if payment already processed (prevent duplicates)
    const existingPurchase = await FollowPurchase.findOne({
      paymentId: payment.id,
    });

    if (existingPurchase) {
      // Already processed this payment
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }

    // Find follower user by Whop userId and companyId
    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
      companyId: capperCompanyId,
    });

    if (!followerUser) {
      console.error('Follower user not found:', {
        whopUserId: followerWhopUserId,
        companyId: capperCompanyId,
      });
      // Still return 200 so Whop doesn't retry
      // User might not be set up yet in our system
      return NextResponse.json({ received: true, userNotFound: true }, { status: 200 });
    }

    // Find capper user
    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      console.error('Capper user not found:', capperUserId);
      return NextResponse.json(
        { error: 'Capper user not found' },
        { status: 400 }
      );
    }

    // Verify this plan ID matches the capper's follow offer plan
    if (capperUser.followOfferPlanId !== planId) {
      console.error('Plan ID mismatch:', {
        expected: capperUser.followOfferPlanId,
        received: planId,
      });
      return NextResponse.json(
        { error: 'Plan ID mismatch' },
        { status: 400 }
      );
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

    return NextResponse.json(
      {
        success: true,
        followPurchaseId: followPurchase._id,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error processing webhook:', error);
    // Return 500 so Whop will retry
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

