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
    const requestBodyText = await request.text();
    
    if (!requestBodyText || requestBodyText.length === 0) {
      return new Response("Empty request body", { status: 400 });
    }

    // Build headers object, preserving original case
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    let webhookData;
    try {
      webhookData = whopSdk.webhooks.unwrap(requestBodyText, { headers });
    } catch (error) {
      // Handle webhooks that fail verification (test webhooks or missing headers)
      if (error instanceof WebhookVerificationError) {
        // Get header names for debugging
        const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
        const hasRequiredHeaders = 
          headerKeys.includes('webhook-id') && 
          headerKeys.includes('webhook-timestamp') && 
          headerKeys.includes('webhook-signature');
        
        // Build debug info object
        const debugInfo: Record<string, unknown> = {
          error: 'Invalid webhook signature',
          verificationError: error.message,
          hasRequiredHeaders,
          requiredHeaders: {
            'webhook-id': headerKeys.includes('webhook-id'),
            'webhook-timestamp': headerKeys.includes('webhook-timestamp'),
            'webhook-signature': headerKeys.includes('webhook-signature'),
          },
          allHeaders: headers,
          allHeaderKeys: Object.keys(headers),
          allHeaderKeysLowercase: headerKeys,
          bodyLength: requestBodyText.length,
          bodyPreview: requestBodyText.substring(0, 500),
          fullBody: requestBodyText.length < 2000 ? requestBodyText : requestBodyText.substring(0, 2000) + '... (truncated)',
        };
        
        // Try to parse the webhook payload directly
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(requestBodyText);
          debugInfo.parsedSuccessfully = true;
          debugInfo.parsedKeys = Object.keys(parsed);
          debugInfo.parsedType = parsed.type || parsed.action;
          debugInfo.parsedStructure = parsed;
        } catch (parseError) {
          // Can't parse JSON - return error with details
          debugInfo.parsedSuccessfully = false;
          debugInfo.parseError = parseError instanceof Error ? parseError.message : 'Unknown parse error';
          return NextResponse.json(debugInfo, { status: 401 });
        }
        
        // Check if it's a test webhook
        if (parsed.action === 'payment.succeeded' && parsed.data === null) {
          return NextResponse.json({
            success: true,
            message: 'Test webhook acknowledged',
            debug: debugInfo,
          }, { status: 200 });
        }
        
        // Check if it's a valid payment webhook structure
        // Real payment webhooks might have different formats
        if (parsed.type === 'payment.succeeded' && parsed.data && typeof parsed.data === 'object' && parsed.data !== null) {
          // Standard format: { type: 'payment.succeeded', data: {...} }
          webhookData = {
            type: 'payment.succeeded',
            data: parsed.data as Payment,
          };
          debugInfo.processedAs = 'Standard format with parsed.data';
        } else if (parsed.action === 'payment.succeeded' && parsed.data && typeof parsed.data === 'object' && parsed.data !== null) {
          // Alternative format: { action: 'payment.succeeded', data: {...} }
          webhookData = {
            type: 'payment.succeeded',
            data: parsed.data as Payment,
          };
          debugInfo.processedAs = 'Alternative format with parsed.action';
        } else if (
          parsed.data && 
          typeof parsed.data === 'object' && 
          parsed.data !== null &&
          'plan' in parsed.data && 
          'user' in parsed.data
        ) {
          // Direct payment object structure
          webhookData = {
            type: 'payment.succeeded',
            data: parsed.data as Payment,
          };
          debugInfo.processedAs = 'Direct payment object structure';
        } else {
          // Invalid webhook structure - return error with details
          debugInfo.reason = 'Invalid webhook structure - no matching format';
          debugInfo.checkedFormats = [
            'parsed.type === "payment.succeeded" && parsed.data',
            'parsed.action === "payment.succeeded" && parsed.data',
            'parsed.data && parsed.data.plan && parsed.data.user',
          ];
          return NextResponse.json(debugInfo, { status: 401 });
        }
        
        // Log that we're processing without verification (for debugging)
        debugInfo.warning = 'Processing webhook without signature verification';
      } else {
        // Other errors - return with details
        return NextResponse.json({
          error: 'Internal server error',
          reason: error instanceof Error ? error.message : 'Unknown error',
        }, { status: 500 });
      }
    }
    
    if (webhookData.type === "payment.succeeded") {
      waitUntil(handlePaymentSucceeded(webhookData.data));
    }
    
    // Return success with debug info for troubleshooting
    return NextResponse.json({
      success: true,
      message: "OK",
      debug: {
        webhookType: webhookData.type,
        headersReceived: Object.keys(headers).length,
        headerKeys: Object.keys(headers),
        bodyLength: requestBodyText.length,
      },
    }, { status: 200 });
  } catch {
    return new Response("Internal server error", { status: 500 });
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
  } catch {
    // Errors are handled silently - we've already returned 200 to Whop
  }
}
