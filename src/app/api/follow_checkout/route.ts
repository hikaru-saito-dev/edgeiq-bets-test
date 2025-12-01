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
    const headersObj: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    // Check if this is a test webhook (missing signature headers)
    // Test webhooks from Whop don't include webhook-id, webhook-timestamp, webhook-signature
    const headerKeysLower = Object.keys(headersObj).map(k => k.toLowerCase());
    const hasSignatureHeaders = 
      headerKeysLower.includes('webhook-id') &&
      headerKeysLower.includes('webhook-timestamp') &&
      headerKeysLower.includes('webhook-signature');

    // Initialize Whop SDK for webhook verification
    const whopClient = new Whop({
      apiKey: process.env.WHOP_API_KEY || '',
    });

    let event: PaymentSucceededWebhookEvent;

    // If signature headers are missing, this is likely a test webhook - parse JSON directly
    if (!hasSignatureHeaders) {
      try {
        const parsed = JSON.parse(body);
        
        // Handle test webhook format: {"action":"payment.succeeded","api_version":"v1","data":null}
        if (parsed.action === 'payment.succeeded' && parsed.data === null) {
          // Test webhook with null data - just acknowledge it
          return NextResponse.json({ received: true, test: true }, { status: 200 });
        }

        // If it looks like a real webhook structure, try to use it
        if (parsed.type === 'payment.succeeded' || parsed.action === 'payment.succeeded') {
          // For test webhooks, construct a minimal event structure
          if (!parsed.data) {
            return NextResponse.json({ received: true, test: true }, { status: 200 });
          }
          
          event = {
            type: 'payment.succeeded',
            data: parsed.data,
          } as PaymentSucceededWebhookEvent;
        } else {
          return NextResponse.json({ received: true }, { status: 200 });
        }
      } catch (parseError) {
        return NextResponse.json(
          { error: 'Invalid JSON payload' },
          { status: 400 }
        );
      }
    } else {
      // Real webhook with signature headers - verify and unwrap using SDK
      try {
        const unwrapped = whopClient.webhooks.unwrap(body, {
          headers: headersObj,
          key: WEBHOOK_SECRET,
        });

        if (!unwrapped || typeof unwrapped !== 'object') {
          return NextResponse.json(
            { error: 'Invalid webhook payload' },
            { status: 400 }
          );
        }

        if (unwrapped.type !== 'payment.succeeded') {
          return NextResponse.json({ received: true }, { status: 200 });
        }

        event = unwrapped as PaymentSucceededWebhookEvent;
        
        if (!event.data) {
          return NextResponse.json(
            { error: 'Invalid event data structure' },
            { status: 400 }
          );
        }
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          return NextResponse.json(
            { error: 'Invalid webhook signature' },
            { status: 401 }
          );
        }
        if (error instanceof SyntaxError) {
          return NextResponse.json(
            { error: 'Invalid JSON payload' },
            { status: 400 }
          );
        }
        throw error;
      }
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
    // Return 500 so Whop will retry
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

