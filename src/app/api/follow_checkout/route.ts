import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
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
  webhookKey: btoa(WEBHOOK_SECRET),
});

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    
    if (!body || body.length === 0) {
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }

    const headers = Object.fromEntries(request.headers);

    let webhookData;
    try {
      webhookData = whopSdk.webhooks.unwrap(body, { headers });
    } catch (error) {
      try {
        const parsed = JSON.parse(body);
        if (parsed.action === 'payment.succeeded' && parsed.data === null) {
          return NextResponse.json({ received: true, test: true }, { status: 200 });
        }
      } catch {
      }
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    if (webhookData.type === 'payment.succeeded') {
      waitUntil(handlePaymentSucceeded(webhookData.data));
      return NextResponse.json({ received: true }, { status: 200 });
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handlePaymentSucceeded(payment: Payment) {
  try {
    await connectDB();

    const planId = payment.plan?.id;
    
    const paymentMetadata = (payment.metadata || {}) as {
      followPurchase?: boolean;
      capperUserId?: string;
      capperCompanyId?: string;
      numPlays?: number;
    };
    
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

    const existingPurchase = await FollowPurchase.findOne({
      paymentId: payment.id,
    });

    if (existingPurchase) {
        return;
    }

    const followerUser = await User.findOne({
      whopUserId: followerWhopUserId,
      companyId: capperCompanyId,
    });

    if (!followerUser) {
      return;
    }

    const capperUser = await User.findById(capperUserId);

    if (!capperUser) {
      return;
    }

    if (capperUser.followOfferPlanId !== planId) {
      return;
    }

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
  }
}
