import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { WebhookVerificationError } from 'standardwebhooks';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { FollowPurchase } from '@/models/FollowPurchase';
import { Whop } from '@whop/sdk';
import type { Payment } from '@whop/sdk/resources.js';

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('WHOP_WEBHOOK_SECRET environment variable is required');
}

const whopSdk = new Whop({
  appID: process.env.NEXT_PUBLIC_WHOP_APP_ID,
  apiKey: process.env.WHOP_API_KEY || '',
  webhookKey: WEBHOOK_SECRET, // Already in correct whsec_... format from Whop
});

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const requestBodyText = await request.text();

    if (!requestBodyText || requestBodyText.length === 0) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    // Build headers object for verification
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Unwrap and verify webhook signature
    let webhookData;
    try {
      webhookData = whopSdk.webhooks.unwrap(requestBodyText, { headers });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
      }
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // Handle payment succeeded webhooks
    if (webhookData.type === "payment.succeeded") {
      waitUntil(handlePaymentSucceeded(webhookData.data));
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handlePaymentSucceeded(payment: Payment) {
  try {
    await connectDB();

    const planId = payment.plan?.id;

    // Extract metadata from payment
    const paymentMetadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };

    const checkoutMetadata = ((payment as unknown as Record<string, unknown>).checkout_configuration as Record<string, unknown> | undefined)?.metadata || {};

    const checkoutMetadataTyped = checkoutMetadata as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };

    const metadata = { ...checkoutMetadataTyped, ...paymentMetadata };

    // Only process follow purchase webhooks
    if (!metadata.followPurchase || !planId) {
      return;
    }

    const capperUserId = metadata.capperUserId;
    const capperCompanyId = metadata.capperCompanyId || payment.company?.id;
    const numPlays = metadata.numPlays || 10;
    const followerWhopUserId = payment.user?.id;

    if (!capperUserId || !capperCompanyId || !followerWhopUserId) {
      return;
    }

    // Check if we already processed this payment
    const existingPurchase = await FollowPurchase.findOne({
      paymentId: payment.id,
    });

    if (existingPurchase) {
      return;
    }

    // Find the follower user
    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
      companyId: capperCompanyId,
    });

    if (!followerUser) {
      return;
    }

    // Find the capper (content creator)
    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      return;
    }

    // Verify plan ID matches
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
  } catch {
    // Silently fail - webhook already acknowledged with 200
  }
}
