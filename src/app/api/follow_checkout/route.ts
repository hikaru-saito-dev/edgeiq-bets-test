import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';
import { Whop } from '@whop/sdk';
import type { PaymentSucceededWebhookEvent } from '@whop/sdk/resources/webhooks';
import { WebhookVerificationError } from 'standardwebhooks';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('WHOP_WEBHOOK_SECRET environment variable is required');
}

/**
 * POST /api/follow_checkout
 * Webhook endpoint to receive payment.succeeded events from Whop
 * Creates FollowPurchase records when users purchase follow offers
 */
// Disable body parsing - we need raw body for signature verification
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // Get raw body as string for signature verification
    // IMPORTANT: Must be the exact raw body, not parsed JSON
    const body = await request.text();
    
    if (!body || body.length === 0) {
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }

    // Convert Headers to plain object for SDK
    // Pass headers as-is to SDK (it will handle validation and normalization)
    const headersObj: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    // Initialize Whop SDK for webhook verification
    const whopClient = new Whop({
      apiKey: process.env.WHOP_API_KEY || '',
    });

    // Verify and unwrap webhook
    // The SDK uses standardwebhooks.verify() which throws WebhookVerificationError on failure
    let event: PaymentSucceededWebhookEvent;
    try {
      const unwrapped = whopClient.webhooks.unwrap(body, {
        headers: headersObj,
        key: WEBHOOK_SECRET,
      });

      // Validate unwrapped event structure
      if (!unwrapped || typeof unwrapped !== 'object') {
        return NextResponse.json(
          { error: 'Invalid webhook payload' },
          { status: 400 }
        );
      }

      // Type guard to check if it's a payment.succeeded event
      if (unwrapped.type !== 'payment.succeeded') {
        // Not a payment.succeeded event, but webhook is valid - return 200
        return NextResponse.json({ received: true }, { status: 200 });
      }

      event = unwrapped as PaymentSucceededWebhookEvent;

      console.error('Error processing webhook:', event);
      return NextResponse.json(
        { error: 'Error processing webhook:', event },
        { status: 400 }
      );
      
      // Validate event has required data structure
      if (!event.data) {
        return NextResponse.json(
          { error: 'Invalid event data structure' },
          { status: 400 }
        );
      }
    } catch (error) {
      // standardwebhooks throws WebhookVerificationError on signature mismatch
      if (error instanceof WebhookVerificationError) {
        return NextResponse.json(
          { error: 'Invalid webhook signature' },
          { status: 401 }
        );
      }

      // Handle Base64 decoding errors (common with test webhooks that have malformed signatures)
      if (error instanceof Error && error.message.includes('Base64Coder')) {
        return NextResponse.json(
          { error: 'Invalid webhook signature format' },
          { status: 401 }
        );
      }
      // Handle JSON parsing errors
      if (error instanceof SyntaxError) {
        return NextResponse.json(
          { error: 'Invalid JSON payload' },
          { status: 400 }
        );
      }
      // Re-throw other errors to be caught by outer catch
      throw error;
    }

    // Extract payment data
    const payment = event.data;
    const planId = payment.plan?.id;
    
    // Check metadata in both payment.metadata and checkout_configuration.metadata
    // Whop stores checkout metadata in the payment object, but the structure may vary
    const paymentMetadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };
    
    // Access checkout_configuration via type assertion since it may exist in the webhook payload
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
      // Not a follow purchase, but webhook is valid - return 200
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Extract follow purchase details from metadata
    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || payment.company?.id;
    const numPlays = metadata.numPlays || 10;
    const followerWhopUserId = payment.user?.id;

    if (!capperUserId || !capperCompanyId || !followerWhopUserId) {
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
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Find capper user
    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      return NextResponse.json(
        { error: 'Capper user not found' },
        { status: 400 }
      );
    }

    // Verify this plan ID matches the capper's follow offer plan
    if (capperUser.followOfferPlanId !== planId) {
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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

